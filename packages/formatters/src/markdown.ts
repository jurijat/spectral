import { printPath, PrintStyle } from '@stoplight/spectral-runtime';
import { DiagnosticSeverity } from '@stoplight/types';
import { Formatter, FormatterContext } from './types';
import { groupBySource } from './utils';
import markdownEscape from 'markdown-escape';
import { getRuleDocumentationUrl } from './utils/getDocumentationUrl';

export const markdown: Formatter = (results, _options, ctx?: FormatterContext) => {
  const groupedResults = groupBySource(results);

  const lines: string[][] = [];
  for (const [source, validationResults] of Object.entries(groupedResults)) {
    validationResults.sort((a, b) => a.range.start.line - b.range.start.line);

    if (validationResults.length > 0) {
      for (const result of validationResults) {
        const ruleDocumentationUrl = getRuleDocumentationUrl(result.code, ctx);
        const codeWithOptionalLink =
          ruleDocumentationUrl != null
            ? `[${result.code.toString()}](${ruleDocumentationUrl})`
            : result.code.toString();
        const escapedPath = markdownEscape(printPath(result.path, PrintStyle.Dot));
        const escapedMessage = markdownEscape(result.message);
        const severityString = DiagnosticSeverity[result.severity];
        const start = `${result.range.start.line}:${result.range.start.character}`;
        const end = `${result.range.end.line}:${result.range.end.character}`;
        const escapedSource = markdownEscape(source);
        lines.push([codeWithOptionalLink, escapedPath, escapedMessage, severityString, start, end, escapedSource]);
      }
    }
  }

  const headers = ['Code', 'Path', 'Message', 'Severity', 'Start', 'End', 'Source'];
  return createMdTable(headers, lines);
};

function createMdTable(headers: string[], lines: string[][]): string {
  // Find the width of each column. Not Math.max(...lines.map(...)): spreading a
  // row per finding throws RangeError above ~125k rows.
  const columnLengths = headers.map((header, i) => {
    let width = header.length;
    for (const line of lines) {
      if (line[i].length > width) width = line[i].length;
    }
    return width;
  });

  let string = '';
  //create markdown table header
  string += '|';
  for (const header of headers) {
    string += ` ${header}`;
    string += ' '.repeat(columnLengths[headers.indexOf(header)] - header.length);
    string += ' |';
  }

  //create markdown table rows delimiter
  string += '\n|';
  for (const _ of headers) {
    string += ' ';
    string += '-'.repeat(columnLengths[headers.indexOf(_)]);
    string += ' |';
  }

  //create markdown table rows
  for (const line of lines) {
    string += '\n|';
    // indexOf(cell) returns the FIRST matching cell, so a row containing two
    // equal values padded every occurrence to the first one's column width.
    for (let i = 0; i < line.length; i++) {
      const cell = line[i];
      string += ` ${cell}`;
      string += ' '.repeat(columnLengths[i] - cell.length);
      string += ' |';
    }
  }

  return string;
}
