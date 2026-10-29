import client from 'prom-client';
import { registro } from './metricas';

// Contadores de negocio. Sem label de alta cardinalidade (nada de pedido_id
// ou cliente_id): esses identificadores vivem no span e no log, nao na metrica.

export const pedidosCriadosTotal = new client.Counter({
  name: 'pedidos_criados_total',
  help: 'Total de pedidos criados pela API',
  registers: [registro],
});

export const pedidosConfirmadosTotal = new client.Counter({
  name: 'pedidos_confirmados_total',
  help: 'Total de pedidos confirmados pelo worker',
  registers: [registro],
});

export const cobrancasProcessadasTotal = new client.Counter({
  name: 'cobrancas_processadas_total',
  help: 'Total de cobrancas processadas, por resultado',
  labelNames: ['resultado'],
  registers: [registro],
});

export type ResultadoCobranca = 'aprovada' | 'recusada' | 'falha';

// Inicializa cada serie em zero na subida. Serie que so nasce no primeiro
// evento some do grafico enquanto esta tudo bem e quebra o alerta que dependia
// dela. Isso vale tambem para cada valor do label resultado.
export function inicializarMetricasDeNegocio(): void {
  pedidosCriadosTotal.inc(0);
  pedidosConfirmadosTotal.inc(0);
  cobrancasProcessadasTotal.inc({ resultado: 'aprovada' }, 0);
  cobrancasProcessadasTotal.inc({ resultado: 'recusada' }, 0);
  cobrancasProcessadasTotal.inc({ resultado: 'falha' }, 0);
}
