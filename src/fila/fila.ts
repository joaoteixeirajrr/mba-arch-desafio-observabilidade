import { context, propagation } from '@opentelemetry/api';
import Redis from 'ioredis';

export const NOME_DA_FILA = 'pedidos';

export type MensagemPedido = {
  pedido_id: number;
  cliente_id: string;
  valor_total: number;
};

// Carrier W3C Trace Context (traceparent/tracestate) viaja junto com a
// mensagem para que o trace atravesse a fila.
type Carrier = Record<string, string>;

type MensagemNaFila = MensagemPedido & { _contexto?: Carrier };

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function criarConexaoRedis(): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export async function publicarPedido(
  redis: Redis,
  mensagem: MensagemPedido
): Promise<void> {
  // Injeta o contexto de trace ativo (o span pedido.criar) no carrier, para
  // que o worker continue o mesmo trace ao consumir.
  const carrier: Carrier = {};
  propagation.inject(context.active(), carrier);

  const comContexto: MensagemNaFila = { ...mensagem, _contexto: carrier };
  await redis.lpush(NOME_DA_FILA, JSON.stringify(comContexto));
}

export async function consumirPedido(
  redis: Redis,
  segundosDeEspera = 5
): Promise<Record<string, unknown> | null> {
  const resposta = await redis.brpop(NOME_DA_FILA, segundosDeEspera);

  if (!resposta) {
    return null;
  }

  return JSON.parse(resposta[1]) as Record<string, unknown>;
}

// Extrai o contexto de trace do carrier da mensagem a partir de um contexto
// raiz (ROOT_CONTEXT, aqui representado pelo context.active() na subida do
// loop, que nao tem span ativo), e nao de um contexto que ja tenha span do
// worker. Assim o span pedido.processar nasce como filho do trace da API.
export function extrairContextoDaMensagem(
  mensagem: Record<string, unknown>,
  contextoBase = context.active()
) {
  const carrier = (mensagem._contexto as Carrier | undefined) ?? {};
  return propagation.extract(contextoBase, carrier);
}
