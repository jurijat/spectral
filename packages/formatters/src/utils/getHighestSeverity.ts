import { DiagnosticSeverity } from '@stoplight/types';
import { IRuleResult } from '@stoplight/spectral-core';

export const getHighestSeverity = (results: IRuleResult[]): DiagnosticSeverity => {
  if (results.length === 0) return DiagnosticSeverity.Hint;

  // Not Math.min(...results.map(...)): spreading the results array as arguments
  // throws RangeError above ~125k entries, which a large document reaches.
  let highest: number = results[0].severity;
  for (let i = 1; i < results.length; i++) {
    if (results[i].severity < highest) highest = results[i].severity;
  }

  return highest;
};
