import { trace } from '@opentelemetry/api';
import { NOME_DO_SERVICO } from './servico';

// Tracer unico da aplicacao, usado para abrir spans manuais de negocio.
export const tracer = trace.getTracer(NOME_DO_SERVICO);
