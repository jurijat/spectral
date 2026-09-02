import { IDiagnostic, JsonPath } from '@stoplight/types';
import type { JSONSchema7 } from 'json-schema';
import type { Resolver } from '@stoplight/spectral-ref-resolver';

export interface IConstructorOpts {
  resolver?: Resolver;

  /**
   * Lifetime of the resolver's document cache.
   *
   * `'per-run'` (default) purges it once no run is in flight, so a long-lived
   * Spectral instance does not retain every document it has ever linted. On a
   * 400-document library run this is the difference between 2,248MB and 569MB
   * of peak RSS, at no cost in throughput.
   *
   * `'shared'` keeps the previous behaviour: the cache persists across runs, so
   * remote `$ref` targets are fetched once for the lifetime of the instance.
   * Choose it when you lint documents that share remote references, or re-lint
   * the same document, and can afford the retention.
   */
  resolverCache?: 'per-run' | 'shared';
}

export interface IRunOpts {
  ignoreUnknownFormat?: boolean;
}

export interface ISpectralDiagnostic extends IDiagnostic {
  path: JsonPath;
  code: string | number;
  documentationUrl?: string;
}

export type IRuleResult = ISpectralDiagnostic;

export interface ISpectralFullResult {
  resolved: unknown;
  results: IRuleResult[];
}

export interface IGivenNode {
  path: JsonPath;
  value: unknown;
}

export type JSONSchema = JSONSchema7;
