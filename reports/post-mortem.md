# Post-mortem: pedidos confirmados sem cobrança

## Resumo

Durante o fechamento do mês, o financeiro identificou pedidos marcados como
`confirmado` que nunca geraram cobrança. A causa é um tratamento de exceção no
worker que, quando o gateway de pagamento lança erro, engole a falha e deixa o
pedido seguir para `confirmado`. Do lado de fora tudo retorna 2xx e o cliente
vê sucesso, então o monitoramento de caixa-preta nunca enxergou o problema.

## Impacto

No período reproduzido com `cenario-a`:

- **Pedidos afetados: 96.** Origem: consulta direta ao Postgres —
  `SELECT count(*) FROM pedidos WHERE cliente_id LIKE '%7' AND status='confirmado'`
  retornou 96. Esse mesmo número bate com a métrica
  `cobrancas_processadas_total{resultado="falha"}` = 96 lida em `/metrics` do
  worker. (O `increase(cobrancas_processadas_total{resultado="falha"}[15m])` do
  Prometheus devolveu ≈99,3 — é estimativa extrapolada da janela, não contagem
  exata, por isso diverge em alguns pedidos do valor real de 96.)
- **Valor envolvido: R$ 95.095,74.** Origem: Postgres —
  `SELECT round(sum(valor_total)::numeric,2) FROM pedidos WHERE cliente_id LIKE '%7' AND status='confirmado'`.
  Esse número **não** vem da métrica: as métricas de negócio não carregam valor
  monetário (de propósito, para não virar label de alta cardinalidade), então a
  contagem de pedidos afetados sai da métrica/log mas o valor só sai do banco.

A assinatura do problema também aparece na telemetria agregada: no mesmo
período `pedidos_confirmados_total` = 211 enquanto
`cobrancas_processadas_total{resultado="aprovada"}` = 115. A diferença de 96 é
exatamente o rombo: pedido confirmado sem dinheiro entrando.

## Detecção

Hoje o problema só foi descoberto no fechamento manual do mês, cruzando pedidos
confirmados com o que entrou em caixa — ou seja, semanas depois do fato.

Com a instrumentação nova, o alerta `FalhaEmCobrancas` detecta o mesmo problema
em **~92 segundos** na reprodução: `cenario-a` iniciado às `20:56:16Z`, webhook
`alerta=FalhaEmCobrancas status=firing` recebido no `receptor-alertas` às
`20:57:48Z`. Esse tempo é a soma do `for: 1m` da regra, do `group_wait` do
Alertmanager e do preenchimento da janela do `rate()`.

A diferença — de semanas para menos de dois minutos — é o que separa um
incidente descoberto no caixa de um incidente capturado em produção enquanto
ainda está acontecendo e dá para agir.

## Causa raiz

Arquivo `src/worker/conciliacao.ts`, função `decidirStatusDoPedido`. Quando
`processarPagamento` lança exceção (gateway respondeu de forma inesperada), o
`catch` registra a ocorrência mas **não** marca `recusado`, então a variável
continua `false` e o pedido vira `confirmado`:

```ts
export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;
    // ...instrumentacao...
  } catch (erro) {
    registrarFalhaLegado(erro);
    // ...instrumentacao... recusado continua false
  }

  return recusado ? 'recusado' : 'confirmado';
}
```

Como `recusado` permanece `false` no caminho de exceção, a função devolve
`confirmado` para um pedido cuja cobrança nunca completou.

## Evidências

- **trace_id (Jaeger):** `f1dfa632200eb7627f5f635d54df9217`. Trace único com
  spans dos serviços `api` e `worker`; o span `pedido.processar` está marcado
  com `error=true` e `otel.status_code=ERROR`. Também confirmado em
  `9b89a99881376f3dd8cc018475d77c58`, trace de um pedido que contém
  `pedido.criar` (api) e `pedido.processar` (worker) sob o mesmo `trace_id`,
  provando a travessia da fila.
- **Query PromQL (SLI de falha):**
  ```promql
  sum(rate(cobrancas_processadas_total{resultado="falha"}[5m]))
    / clamp_min(sum(rate(cobrancas_processadas_total[5m])), 0.0001)
  ```
  Resultado durante `cenario-a`: `0.4258` (42,6% das cobranças falhando), muito
  acima do limiar de 1% do SLO — alerta `firing` com `value=4.258...` (a
  expressão dividida pelo limiar).
- **Busca no log:**
  ```bash
  docker compose logs api worker | grep 9b89a99881376f3dd8cc018475d77c58
  ```
  Devolveu três linhas: uma da `api` (`pedido 25 criado`) e duas do `worker`
  (`mensagem ... recebida da fila`, `pedido 25 ficou confirmado`), todas com o
  mesmo `trace_id`. E a busca por falhas:
  ```bash
  docker compose logs worker | grep '"level":"error"'
  ```
  devolveu 96 linhas `falha na cobranca do cliente cli-XXX7: gateway respondeu
  de forma inesperada`, cada uma com seu `trace_id` e `span_id`.

## Lições aprendidas

**O que correu bem.** Assim que as métricas de negócio e a correlação
log↔trace existiram, a causa ficou óbvia em minutos: a divergência entre
`pedidos_confirmados_total` e `cobrancas aprovadas` apontou o rombo, e o
`trace_id` levou direto ao span de erro no worker.

**O que correu mal.** O sistema passou semanas confirmando pedidos sem cobrança
sem nenhum sinal. Monitoramento de caixa-preta (status HTTP) dava tudo verde
porque o erro acontecia depois da resposta ao cliente, de forma assíncrona na
fila. Faltava instrumentação que contasse o que o código já sabia.

**Onde tivemos sorte.** O defeito atinge só um subconjunto determinístico de
clientes (final 7), então o rombo foi grande mas limitado; se o gateway
falhasse de forma aleatória para qualquer cliente, o prejuízo mensal seria
maior e mais difícil de isolar.

## Itens de ação

| Ação | Tipo | Prioridade |
| ---- | ---- | ---------- |
| Corrigir `decidirStatusDoPedido`: em exceção na cobrança, o pedido não pode virar `confirmado` (marcar como `recusado`/`falha_pagamento` e reprocessar). Descrita, não executada neste post-mortem. | evitar | alta |
| Manter o alerta `FalhaEmCobrancas` ligado ao SLO de 99% e revisar o alvo após 30 dias de histórico real | mitigar | alta |
| Criar reconciliação automática periódica entre `pedidos confirmados` e `cobranças aprovadas`, disparando alerta quando divergirem | mitigar | média |
| Adicionar teste de regressão cobrindo o caminho de exceção do gateway (cliente final 7) garantindo que o pedido não fique `confirmado` | evitar | média |

## Timeline

Horários em UTC, reconstruídos a partir dos logs, do Jaeger e do
`receptor-alertas`.

- **20:53:47Z** — pedido 25 criado na `api` e processado no `worker` sob o
  trace `9b89a99881376f3dd8cc018475d77c58` (tráfego saudável, baseline).
- **20:56:16Z** — início do `cenario-a` (reprodução da queixa).
- **20:58:03Z em diante** — worker começa a registrar linhas `level=error`
  `falha na cobranca do cliente cli-XXX7` (96 ocorrências no total), cada uma
  com trace marcado como erro no Jaeger.
- **20:57:48Z** — `FalhaEmCobrancas` dispara e o webhook chega ao
  `receptor-alertas` (`status=firing`), ~92s após o início do cenário.
- **Pós-incidente** — consulta ao Postgres confirma 96 pedidos `confirmado` de
  clientes final 7, somando R$ 95.095,74, batendo com a métrica de falha.
