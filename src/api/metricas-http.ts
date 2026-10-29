import type { NextFunction, Request, Response } from 'express';
import client from 'prom-client';
import { registro } from '../telemetria/metricas';

const duracaoDasRequisicoes = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duracao das requisicoes HTTP em segundos',
  labelNames: ['route', 'method', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registro],
});

export function medirRequisicoes(
  requisicao: Request,
  resposta: Response,
  proximo: NextFunction
): void {
  const encerrarMedicao = duracaoDasRequisicoes.startTimer();

  resposta.on('finish', () => {
    // Usa o template da rota (ex.: /produtos/:id) e nunca o caminho concreto
    // (ex.: /produtos/42). Caminho concreto gera uma serie nova por id e
    // explode a cardinalidade do Prometheus.
    const template =
      requisicao.route?.path ?? requisicao.baseUrl + (requisicao.route?.path ?? '');
    const rota = template || (requisicao.path === '/' ? '/' : 'desconhecida');

    encerrarMedicao({
      route: rota,
      method: requisicao.method,
      status: String(resposta.statusCode),
    });
  });

  proximo();
}
