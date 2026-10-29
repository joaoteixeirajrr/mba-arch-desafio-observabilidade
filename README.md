# Loja de Pedidos — Observabilidade

Instrumentação de observabilidade (OpenTelemetry, Prometheus, Grafana, Jaeger)
sobre uma aplicação TypeScript de pedidos com `api` + `worker`, Postgres e
Redis. Entrega do desafio "Do sintoma ao post-mortem" do MBA Arquitetura Full
Cycle (módulos de Observabilidade e DevOps/SRE).

## Como rodar

Pré-requisitos: Docker, Docker Compose v2 e `curl`.

```bash
git clone <seu-fork>
cd mba-arch-desafio-observabilidade

cp .env.example .env
docker compose up -d

curl -s localhost:8080/health
```

Isso sobe `api` (8080), `worker` (8081), Postgres, Redis e a stack de
observabilidade: Prometheus (9090), Grafana (3000, admin/admin), Jaeger
(16686), Alertmanager (9093) e `receptor-alertas` (9099).

A pasta `src/` é montada como volume; após editar qualquer arquivo em `src/`,
rode `docker compose restart api worker`. Alterar `package.json` exige
`docker compose up -d --build`.

Gerar carga:

```bash
docker compose run --rm carga normal       # tráfego saudável
docker compose run --rm carga cenario-a     # reproduz a queixa
```

Verificar a correlação log↔trace: pegue um `trace_id` no Jaeger e rode
`docker compose logs api worker | grep <trace_id>` — devem aparecer linhas dos
dois processos.

> Nota: se as portas `5432`/`8080` já estiverem ocupadas na sua máquina, crie um
> `compose.override.yaml` local (não versionado) remapeando apenas as portas
> publicadas; a aplicação usa a rede interna do Docker e não depende delas.

## Equivalências com o curso

O curso ensinou observabilidade em Java (Actuator, Micrometer, bridge do
OpenTelemetry). Aqui, em TypeScript, os conceitos são os mesmos; mudam os
pacotes e a sintaxe.

| Conceito | No curso (Java) | Neste projeto (TypeScript) |
| --- | --- | --- |
| Métricas | Micrometer + Actuator (`/actuator/prometheus`) | `prom-client` expondo `/metrics` (`Counter`, `Histogram`) |
| Tracing | OpenTelemetry Java Agent / SDK, spans via `@WithSpan`/`Tracer` | `@opentelemetry/sdk-node` + auto-instrumentações; spans manuais com `tracer.startActiveSpan` |
| Logs estruturados | Logback/JSON com MDC carregando `trace_id`/`span_id` | logger JSON próprio (`src/telemetria/log.ts`) lendo `trace.getActiveSpan().spanContext()` |
| Propagação de contexto | W3C Trace Context propagado pelo agent (HTTP/messaging) | API `propagation.inject`/`extract` (W3C) com carrier embarcado na mensagem Redis |

## Decisões técnicas

### Erro de cardinalidade (Req 3)

O histograma `http_request_duration_seconds` usava `requisicao.path` como label
`route`, ou seja, o **caminho concreto** (`/produtos/42`, `/pedidos/1001`...).
Cada id vira uma série temporal nova; com ids ilimitados, a cardinalidade
cresce sem teto e o Prometheus consome memória até cair. A correção usa o
**template da rota** (`requisicao.route?.path`, ex.: `/produtos/:id`), que tem
cardinalidade limitada ao número de rotas. Identificadores de pedido/cliente
ficam em span e log, onde custam barato e permitem achar o caso individual —
nunca em label de métrica.

### O que cada métrica de negócio responde

- `pedidos_criados_total` (contador): quantos pedidos a `api` aceitou e
  publicou na fila.
- `pedidos_confirmados_total` (contador): quantos pedidos o `worker` marcou como
  `confirmado`.
- `cobrancas_processadas_total{resultado}` (contador, label `aprovada` /
  `recusada` / `falha`): o que de fato aconteceu na cobrança. A série `falha`
  é o sinal do incidente; a divergência entre `pedidos_confirmados_total` e
  `cobrancas_processadas_total{resultado="aprovada"}` revela pedido confirmado
  sem dinheiro entrando. Os três contadores são inicializados em zero na subida
  (incluindo cada valor de `resultado`), para a série existir antes do primeiro
  evento e não quebrar gráfico nem alerta.

### Qual pergunta cada painel do dashboard responde

Dashboard `Pedidos` (`grafana/provisioning/dashboards/pedidos.json`), 4 painéis:

1. **Cobranças por resultado (req/s)** → *o sistema está com erro?* (a série
   `falha` subindo é o alerta visual).
2. **Proporção de falha na cobrança (SLI)** → *o sistema está com erro?* (o
   mesmo SLI que alimenta o alerta, como número único).
3. **Latência HTTP p95 por rota** → *o sistema está lento?*
4. **Pedidos confirmados x cobranças aprovadas** → *o dinheiro está entrando?*
   (quando confirmados fica acima de aprovadas, há rombo).

## SLO e alerta

- **SLI:** proporção de cobranças processadas que **não** falharam (sucesso =
  `aprovada` ou `recusada`; falha = exceção no gateway, a cobrança nunca
  completou).

  ```promql
  1 - (
    sum(rate(cobrancas_processadas_total{resultado="falha"}[5m]))
      / clamp_min(sum(rate(cobrancas_processadas_total[5m])), 0.0001)
  )
  ```

- **SLO:** 99% de sucesso na janela de **30 dias**.
- **Error budget:** `100% - 99% = 1%`. No máximo 1% das cobranças podem falhar
  dentro da janela.
- **Do SLO ao limiar da regra:** o SLO tolera até 1% de falha, logo o alerta
  `FalhaEmCobrancas` dispara quando a proporção de falha de curto prazo (janela
  de `rate` de 5m) ultrapassa esse teto de `0.01`. O número **sai do SLO**
  (`1 - 0.99 = 0.01`), não de um chute. Regra em
  `prometheus/regras/cobrancas.yml`:

  ```promql
  sum(rate(cobrancas_processadas_total{resultado="falha"}[5m]))
    / clamp_min(sum(rate(cobrancas_processadas_total[5m])), 0.0001)
    > 0.01
  ```

  com `for: 1m` e `severity: critical`. Comportamento verificado: silêncio no
  `cenario normal`, disparo no `cenario-a` (≈92s na reprodução, chegando ao
  `receptor-alertas` como `status=firing`).
