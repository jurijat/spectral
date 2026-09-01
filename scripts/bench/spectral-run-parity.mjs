import { createRequire } from 'node:module';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { DiagnosticSeverity } = require('@stoplight/types');
const { getDiagnosticSeverity } = require(`${ROOT}/packages/core/dist/ruleset/index.js`);
const { generateDocumentWideResult } = require(`${ROOT}/packages/core/dist/utils/generateDocumentWideResult.js`);

// Keep this in lockstep with Spectral.runWithResolved and its two private
// helpers. The benchmark harnesses split that lifecycle into phases rather than
// calling it directly, but their findings must remain identical to Spectral.run.
export const rulesetForDocument = (ruleset, document) => ruleset.fromSource(document.source);

export function prepareRunner(document, inventory, ruleset, runner, ignoreUnknownFormat = false) {
  runner.results.push(...filterParserErrors(document.diagnostics, ruleset.parserOptions));

  if (document.formats === undefined) {
    const foundFormats = [...ruleset.formats].filter(format => format(inventory.resolved, document.source));
    if (foundFormats.length === 0 && ignoreUnknownFormat !== true) {
      document.formats = null;
      if (ruleset.formats.size > 0) {
        runner.addResult(
          generateDocumentWideResult(
            document,
            `The provided document does not match any of the registered formats [${[...ruleset.formats]
              .map(format => format.displayName ?? format.name)
              .join(', ')}]`,
            DiagnosticSeverity.Warning,
            'unrecognized-format',
          ),
        );
      }
    } else {
      document.formats = new Set(foundFormats);
    }
  }
}

function filterParserErrors(diagnostics, parserOptions) {
  return diagnostics.reduce((filtered, diagnostic) => {
    if (diagnostic.code !== 'parser') return filtered;

    let severity;
    if (diagnostic.message.startsWith('Mapping key must be a string scalar rather than')) {
      severity = getDiagnosticSeverity(parserOptions.incompatibleValues);
    } else if (diagnostic.message.startsWith('Duplicate key')) {
      severity = getDiagnosticSeverity(parserOptions.duplicateKeys);
    } else {
      filtered.push(diagnostic);
      return filtered;
    }

    if (severity !== -1) {
      diagnostic.severity = severity;
      filtered.push(diagnostic);
    }
    return filtered;
  }, []);
}
