import { trace } from '@opentelemetry/api';
import { NOME_DO_SERVICO } from './servico';

type Nivel = 'info' | 'warn' | 'error';

type CamposExtras = {
  pedido_id?: number | string;
};

function identificadoresDoTrace(): { trace_id: string; span_id: string } {
  const span = trace.getActiveSpan();

  if (!span) {
    return { trace_id: '', span_id: '' };
  }

  const contexto = span.spanContext();
  return { trace_id: contexto.traceId, span_id: contexto.spanId };
}

function escrever(level: Nivel, msg: string, extras?: CamposExtras): void {
  const { trace_id, span_id } = identificadoresDoTrace();

  const linha: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: NOME_DO_SERVICO,
    msg,
    trace_id,
    span_id,
  };

  if (extras?.pedido_id !== undefined) {
    linha.pedido_id = extras.pedido_id;
  }

  process.stdout.write(JSON.stringify(linha) + '\n');
}

export const log = {
  info(msg: string, extras?: CamposExtras): void {
    escrever('info', msg, extras);
  },
  warn(msg: string, extras?: CamposExtras): void {
    escrever('warn', msg, extras);
  },
  error(msg: string, extras?: CamposExtras): void {
    escrever('error', msg, extras);
  },
};
