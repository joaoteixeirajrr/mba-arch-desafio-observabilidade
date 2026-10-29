import { SpanStatusCode, trace } from '@opentelemetry/api';
import { log } from '../telemetria/log';
import { cobrancasProcessadasTotal } from '../telemetria/metricas-negocio';
import { processarPagamento } from './pagamento';
import { registrarFalhaLegado } from './registro-legado';

export type StatusDoPedido = 'confirmado' | 'recusado';

export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;

    // Instrumentacao: conta o resultado real da cobranca. Nao altera o fluxo,
    // apenas passa a contar o que ja acontecia.
    cobrancasProcessadasTotal.inc({ resultado: recusado ? 'recusada' : 'aprovada' });
  } catch (erro) {
    registrarFalhaLegado(erro);

    // Instrumentacao: a cobranca falhou (excecao). Registra no span ativo,
    // emite log error e conta a falha. O fluxo segue identico: recusado
    // continua false, como no codigo original.
    const motivo = erro as Error;
    const span = trace.getActiveSpan();
    if (span) {
      span.recordException(motivo);
      span.setStatus({ code: SpanStatusCode.ERROR, message: motivo.message });
    }
    log.error('falha na cobranca do cliente ' + clienteId + ': ' + motivo.message);
    cobrancasProcessadasTotal.inc({ resultado: 'falha' });
  }

  return recusado ? 'recusado' : 'confirmado';
}
