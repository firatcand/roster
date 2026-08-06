import { lookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { Agent, type AgentOptions } from 'node:https';
import { isIP } from 'node:net';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { isNonGlobalIpLiteral } from '../network-address.ts';

const BUCKET_RE = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/u;
const REGION_RE = /^[a-z0-9]+(?:-[a-z0-9]+){1,15}$/u;

export const DEFAULT_S3_DNS_TIMEOUT_MS = 3_000;
export const DEFAULT_S3_DNS_MAX_ANSWERS = 32;

export type S3EndpointConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
};

export type ExactS3Origin = {
  protocol: 'https:';
  hostname: string;
  port: number;
  authority: string;
};

export type DnsLookupAll = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export type S3HttpHandler = Pick<NodeHttpHandler, 'metadata' | 'handle' | 'destroy'>;

export type S3NetworkPolicyDeps = {
  lookupAll?: DnsLookupAll;
  agentFactory?: (options: AgentOptions) => Agent;
  handlerFactory?: (agent: Agent) => S3HttpHandler;
};

export class S3NetworkPolicyError extends Error {
  readonly code = 'S3_NETWORK_POLICY_DENIED';
  readonly reason: string;

  constructor(reason: string) {
    super(`S3 request denied by network policy (${reason})`);
    this.name = 'S3NetworkPolicyError';
    this.reason = reason;
  }
}

function assertBucket(bucket: string): void {
  if (!BUCKET_RE.test(bucket)
    || bucket.includes('..')
    || /(?:^|\.)-|-\.|\.$/u.test(bucket)
    || /^\d+\.\d+\.\d+\.\d+$/u.test(bucket)) {
    throw new S3NetworkPolicyError('invalid-bucket');
  }
}

function assertRegion(region: string, customEndpoint: boolean): void {
  if ((!customEndpoint && region === 'auto') || (region !== 'auto' && !REGION_RE.test(region))) {
    throw new S3NetworkPolicyError('invalid-region');
  }
}

function canonicalEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new S3NetworkPolicyError('invalid-endpoint');
  }
  if (parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== '/'
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.origin !== endpoint) {
    throw new S3NetworkPolicyError('invalid-endpoint');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  if (hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || isNonGlobalIpLiteral(hostname)) {
    throw new S3NetworkPolicyError('invalid-endpoint-host');
  }
  return parsed;
}

function awsDnsSuffix(region: string): string {
  if (/^(?:us-iso|us-isob|us-isof|us-isoe|eu-isoe)-/u.test(region)) {
    throw new S3NetworkPolicyError('unsupported-aws-partition');
  }
  return region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
}

export function deriveS3Origin(config: S3EndpointConfig): ExactS3Origin {
  assertBucket(config.bucket);
  assertRegion(config.region, config.endpoint !== undefined);
  const base = config.endpoint === undefined
    ? new URL(`https://s3.${config.region}.${awsDnsSuffix(config.region)}`)
    : canonicalEndpoint(config.endpoint);
  const literalEndpoint = isIP(base.hostname.replace(/^\[|\]$/gu, '')) !== 0;
  const pathStyle = config.forcePathStyle || config.bucket.includes('.') || literalEndpoint;
  const hostname = pathStyle ? base.hostname : `${config.bucket}.${base.hostname}`;
  const port = base.port.length === 0 ? 443 : Number(base.port);
  const authority = port === 443 ? hostname : `${hostname}:${port}`;
  return { protocol: 'https:', hostname, port, authority };
}

function systemLookupAll(
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
): void {
  lookup(hostname, options, callback);
}

function validateAnswers(addresses: readonly LookupAddress[], maximum: number): LookupAddress {
  if (addresses.length === 0) throw new S3NetworkPolicyError('dns-empty');
  if (addresses.length > maximum) throw new S3NetworkPolicyError('dns-answer-limit');
  for (const answer of addresses) {
    if ((answer.family !== 4 && answer.family !== 6)
      || isIP(answer.address) !== answer.family
      || isNonGlobalIpLiteral(answer.address)) {
      throw new S3NetworkPolicyError('dns-address-denied');
    }
  }
  return addresses[0]!;
}

export function createGuardedLookup(
  expectedHostname: string,
  options: {
    lookupAll?: DnsLookupAll;
    timeoutMs?: number;
    maxAnswers?: number;
  } = {},
): NonNullable<AgentOptions['lookup']> {
  const lookupAll = options.lookupAll ?? systemLookupAll;
  const timeoutMs = options.timeoutMs ?? DEFAULT_S3_DNS_TIMEOUT_MS;
  const maxAnswers = options.maxAnswers ?? DEFAULT_S3_DNS_MAX_ANSWERS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new S3NetworkPolicyError('invalid-dns-timeout');
  }
  if (!Number.isSafeInteger(maxAnswers) || maxAnswers < 1 || maxAnswers > 256) {
    throw new S3NetworkPolicyError('invalid-dns-answer-limit');
  }
  return (hostname, lookupOptions, callback) => {
    if (hostname !== expectedHostname) {
      callback(new S3NetworkPolicyError('dns-host-drift'), '', 0);
      return;
    }
    let settled = false;
    const finish = (error: NodeJS.ErrnoException | null, selected?: LookupAddress): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null || selected === undefined) {
        callback(error ?? new S3NetworkPolicyError('dns-resolution-failed'), '', 0);
      } else if (lookupOptions.all === true) {
        callback(null, [selected]);
      } else {
        callback(null, selected.address, selected.family);
      }
    };
    const timer = setTimeout(() => finish(new S3NetworkPolicyError('dns-timeout')), timeoutMs);
    const family = lookupOptions.family;
    const normalizedFamily = family === 'IPv4' ? 4 : family === 'IPv6' ? 6 : family;
    try {
      lookupAll(hostname, {
        all: true,
        order: 'verbatim',
        ...(normalizedFamily === undefined ? {} : { family: normalizedFamily }),
        ...(lookupOptions.hints === undefined ? {} : { hints: lookupOptions.hints }),
      }, (error, addresses) => {
        if (error !== null) {
          finish(new S3NetworkPolicyError('dns-resolution-failed'));
          return;
        }
        try {
          finish(null, validateAnswers(addresses, maxAnswers));
        } catch (validationError) {
          finish(validationError instanceof S3NetworkPolicyError
            ? validationError
            : new S3NetworkPolicyError('dns-resolution-failed'));
        }
      });
    } catch {
      finish(new S3NetworkPolicyError('dns-resolution-failed'));
    }
  };
}

function requestHostHeader(headers: Record<string, string>): string | null {
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'host')
    .map(([, value]) => value);
  return values.length === 1 ? values[0]! : null;
}

export function assertExactS3Request(
  request: Parameters<NodeHttpHandler['handle']>[0],
  origin: ExactS3Origin,
): void {
  const port = request.port ?? 443;
  if (request.protocol !== origin.protocol) throw new S3NetworkPolicyError('protocol-drift');
  if (request.hostname !== origin.hostname) throw new S3NetworkPolicyError('host-drift');
  if (port !== origin.port) throw new S3NetworkPolicyError('port-drift');
  if (requestHostHeader(request.headers) !== origin.authority) {
    throw new S3NetworkPolicyError('host-header-drift');
  }
  if ((request.username?.length ?? 0) > 0 || (request.password?.length ?? 0) > 0) {
    throw new S3NetworkPolicyError('userinfo-forbidden');
  }
}

export class ExactOriginS3RequestHandler implements S3HttpHandler {
  readonly metadata: NodeHttpHandler['metadata'];
  private readonly origin: ExactS3Origin;
  private readonly delegate: S3HttpHandler;

  constructor(origin: ExactS3Origin, delegate: S3HttpHandler) {
    this.origin = origin;
    this.delegate = delegate;
    this.metadata = delegate.metadata;
  }

  handle(
    ...args: Parameters<NodeHttpHandler['handle']>
  ): ReturnType<NodeHttpHandler['handle']> {
    assertExactS3Request(args[0], this.origin);
    return this.delegate.handle(...args);
  }

  destroy(): void {
    this.delegate.destroy();
  }
}

export function createS3NetworkBoundary(
  config: S3EndpointConfig,
  deps: S3NetworkPolicyDeps = {},
): { origin: ExactS3Origin; requestHandler: S3HttpHandler } {
  const origin = deriveS3Origin(config);
  const guardedLookup = createGuardedLookup(origin.hostname, { lookupAll: deps.lookupAll });
  const agent = (deps.agentFactory ?? ((options) => new Agent(options)))({
    keepAlive: false,
    maxCachedSessions: 0,
    autoSelectFamily: false,
    rejectUnauthorized: true,
    lookup: guardedLookup,
  });
  const delegate = (deps.handlerFactory ?? ((httpsAgent) => new NodeHttpHandler({
    httpsAgent,
    connectionTimeout: 10_000,
    socketTimeout: 60_000,
  })))(agent);
  return { origin, requestHandler: new ExactOriginS3RequestHandler(origin, delegate) };
}
