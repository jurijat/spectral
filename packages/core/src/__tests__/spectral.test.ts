import { DiagnosticSeverity } from '@stoplight/types';
import { truthy } from '@stoplight/spectral-functions';
import * as Parsers from '@stoplight/spectral-parsers';
import { Resolver } from '@stoplight/spectral-ref-resolver';
import { Document } from '../document';
import { DocumentInventory } from '../documentInventory';
import { Spectral } from '../spectral';
import { Ruleset } from '../ruleset';

describe('spectral', () => {
  describe('clearCache', () => {
    test('purges resolver entries and releases cached remote documents', () => {
      const resolver = new Resolver();
      const spectral = new Spectral({ resolver });
      const document = new Document('{}', Parsers.Json, 'first.json');
      const firstInventory = new DocumentInventory(document, resolver);
      const remote = new Document('{}', Parsers.Json, 'remote.json');
      firstInventory.referencedDocuments['remote.json'] = remote;

      const sharedInventory = new DocumentInventory(document, resolver);
      expect(sharedInventory.referencedDocuments['remote.json']).toBe(remote);
      resolver.uriCache.set('https://example.com/cached.json', { retained: document });

      const purge = jest.spyOn(resolver.uriCache, 'purge');
      spectral.clearCache();

      expect(purge).toHaveBeenCalledTimes(1);
      expect(resolver.uriCache.has('https://example.com/cached.json')).toBe(false);
      const freshInventory = new DocumentInventory(document, resolver);
      expect(freshInventory.referencedDocuments).not.toBe(firstInventory.referencedDocuments);
      expect(freshInventory.referencedDocuments).toEqual({});
    });
  });

  describe('when a $ref appears', () => {
    describe('and a custom resolver is provided', () => {
      test('will call the resolver with target', async () => {
        const customResolver = new Resolver();

        const resolve = jest.spyOn(customResolver, 'resolve');

        const s = new Spectral({
          resolver: customResolver,
        });

        const target = { foo: 'bar' };

        s.setRuleset(new Ruleset({ rules: {} }));
        await s.run(target);

        expect(resolve).toBeCalledWith(target, {
          authority: undefined,
          parseResolveResult: expect.any(Function),
        });
      });

      test('should recognize the source of local $refs', () => {
        const s = new Spectral();
        const source = 'foo.yaml';

        const document = new Document(
          JSON.stringify(
            {
              paths: {
                '/agreements': {
                  get: {
                    description: 'Get some Agreements',
                    responses: {
                      '200': {
                        $ref: '#/responses/GetAgreementsOk',
                      },
                      default: {},
                    },
                    summary: 'List agreements',
                    tags: ['agreements', 'pagination'],
                  },
                },
              },
              responses: {
                GetAgreementsOk: {
                  description: 'Successful operation',
                  headers: {},
                },
              },
            },
            null,
            2,
          ),
          Parsers.Json,
          source,
        );

        s.setRuleset({
          rules: {
            'pagination-responses-have-x-next-token': {
              description: 'All collection endpoints have the X-Next-Token parameter in responses',
              given: "$.paths..get.responses['200'].headers",
              severity: 'error',
              recommended: true,
              then: { field: 'X-Next-Token', function: truthy },
            },
          },
        });

        return expect(s.run(document)).resolves.toEqual([
          {
            code: 'pagination-responses-have-x-next-token',
            message: 'All collection endpoints have the X-Next-Token parameter in responses',
            path: ['responses', 'GetAgreementsOk', 'headers'],
            range: expect.any(Object),
            severity: DiagnosticSeverity.Error,
            source,
          },
        ]);
      });
    });
  });
});

describe('resolver cache lifetime', () => {
  const doc = (): Document =>
    new Document(`openapi: "3.0.0"\ninfo:\n  title: t\n  version: "1"\npaths: {}\n`, Parsers.Yaml, 'file:///t.yaml');

  it('purges the resolver cache after a run by default', async () => {
    const spectral = new Spectral();
    spectral.setRuleset({ rules: {} });
    const purge = jest.spyOn(spectral['_resolver'].uriCache, 'purge');

    await spectral.run(doc());

    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('keeps the cache across runs when asked to', async () => {
    const spectral = new Spectral({ resolverCache: 'shared' });
    spectral.setRuleset({ rules: {} });
    const purge = jest.spyOn(spectral['_resolver'].uriCache, 'purge');

    await spectral.run(doc());
    await spectral.run(doc());

    expect(purge).not.toHaveBeenCalled();
  });

  it('does not purge while another run is still in flight', async () => {
    const spectral = new Spectral();
    spectral.setRuleset({ rules: {} });
    const purge = jest.spyOn(spectral['_resolver'].uriCache, 'purge');

    // Both runs overlap; the cache must survive until the last one settles,
    // otherwise the earlier run loses documents it is still resolving against.
    await Promise.all([spectral.run(doc()), spectral.run(doc())]);

    expect(purge).toHaveBeenCalledTimes(1);
  });
});
