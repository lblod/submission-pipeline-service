import { querySudo, updateSudo } from '@lblod/mu-auth-sudo';

export const query = querySudo;
export const update = updateSudo;

/**
 * Convert SPARQL JSON SELECT results into an array of plain objects, coercing
 * xsd:integer and xsd:dateTime bindings.
 *
 * @param {object} result SPARQL JSON result object
 * @returns {Array<object>}
 */
export function parseResult(result) {
  if (!(result.results && result.results.bindings.length)) return [];

  const bindingKeys = result.head.vars;
  return result.results.bindings.map((row) => {
    const obj = {};
    bindingKeys.forEach((key) => {
      if (
        row[key] &&
        row[key].datatype === 'http://www.w3.org/2001/XMLSchema#integer' &&
        row[key].value
      ) {
        obj[key] = parseInt(row[key].value);
      } else if (
        row[key] &&
        row[key].datatype === 'http://www.w3.org/2001/XMLSchema#dateTime' &&
        row[key].value
      ) {
        obj[key] = new Date(row[key].value);
      } else {
        obj[key] = row[key] ? row[key].value : undefined;
      }
    });
    return obj;
  });
}
