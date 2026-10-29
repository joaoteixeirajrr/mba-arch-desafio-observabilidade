import { ROOT_CONTEXT, SpanStatusCode, context } from '@opentelemetry/api';
import http from 'node:http';
import { atualizarStatusPedido } from '../db/consultas';
import { esperarBanco, fecharPool } from '../db/pool';
import { migrar } from '../db/migracao';
import {
  consumirPedido,
  criarConexaoRedis,
  extrairContextoDaMensagem,
} from '../fila/fila';
import { log } from '../telemetria/log';
import { TIPO_DE_CONTEUDO, coletar } from '../telemetria/metricas';
import {
  inicializarMetricasDeNegocio,
  pedidosConfirmadosTotal,
} from '../telemetria/metricas-negocio';
import { tracer } from '../telemetria/tracer';
import { decidirStatusDoPedido } from './conciliacao';

const porta = Number(process.env.WORKER_PORT ?? process.env.PORT ?? 8081);

let rodando = true;

function iniciarServidorDeSaude(): http.Server {
  const servidor = http.createServer(async (requisicao, resposta) => {
    if (requisicao.url === '/health') {
      resposta.writeHead(200, { 'content-type': 'application/json' });
      resposta.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (requisicao.url === '/metrics') {
      resposta.writeHead(200, { 'content-type': TIPO_DE_CONTEUDO });
      resposta.end(await coletar());
      return;
    }

    resposta.writeHead(404, { 'content-type': 'application/json' });
    resposta.end(JSON.stringify({ erro: 'rota nao encontrada' }));
  });

  servidor.listen(porta, () => {
    log.info('worker ouvindo na porta ' + porta);
  });

  return servidor;
}

async function processarMensagem(mensagem: Record<string, unknown>): Promise<void> {
  const pedidoId = Number(mensagem.pedido_id);
  const clienteId = String(mensagem.cliente_id);
  const valorTotal = Number(mensagem.valor_total);

  // Extrai o contexto de trace da mensagem a partir de um contexto raiz
  // (ROOT_CONTEXT), e nao do contexto ativo do worker, para que o span
  // pedido.processar continue o trace da API em vez de nascer solto.
  const contextoDoTrace = extrairContextoDaMensagem(mensagem, ROOT_CONTEXT);

  await context.with(contextoDoTrace, async () => {
    await tracer.startActiveSpan('pedido.processar', async (span) => {
      try {
        span.setAttribute('pedido.id', pedidoId);
        span.setAttribute('cliente.id', clienteId);
        span.setAttribute('pedido.valor_total', valorTotal);

        log.info('mensagem do pedido ' + pedidoId + ' recebida da fila', {
          pedido_id: pedidoId,
        });

        const status = await decidirStatusDoPedido(clienteId, valorTotal);
        await atualizarStatusPedido(pedidoId, status);

        span.setAttribute('pedido.status', status);
        if (status === 'confirmado') {
          pedidosConfirmadosTotal.inc();
        }

        log.info('pedido ' + pedidoId + ' ficou ' + status, { pedido_id: pedidoId });
      } catch (erro) {
        const motivo = erro as Error;
        span.recordException(motivo);
        span.setStatus({ code: SpanStatusCode.ERROR, message: motivo.message });
        log.error('falha ao processar pedido ' + pedidoId + ': ' + motivo.message, {
          pedido_id: pedidoId,
        });
        throw motivo;
      } finally {
        span.end();
      }
    });
  });
}

async function iniciar(): Promise<void> {
  inicializarMetricasDeNegocio();

  await esperarBanco();
  await migrar();

  const redis = criarConexaoRedis();
  const servidor = iniciarServidorDeSaude();

  const encerrar = () => {
    rodando = false;
    servidor.close(async () => {
      redis.disconnect();
      await fecharPool();
      process.exit(0);
    });
  };

  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  log.info('worker consumindo a fila de pedidos');

  while (rodando) {
    try {
      const mensagem = await consumirPedido(redis);

      if (mensagem) {
        await processarMensagem(mensagem);
      }
    } catch (erro) {
      log.error('erro ao ler a fila: ' + (erro as Error).message);
      await new Promise((resolver) => setTimeout(resolver, 1000));
    }
  }
}

iniciar().catch((erro) => {
  log.error('worker nao conseguiu iniciar: ' + erro.message);
  process.exit(1);
});
