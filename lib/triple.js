import { sparqlEscapeUri, sparqlEscapeString } from 'mu';

/**
 * A plain RDF triple, used to collect harvested and enriched knowledge before it is
 * written out as Turtle. Ported from import-submission-service.
 */
export default class Triple {
  constructor({ subject, predicate, object, datatype }) {
    this.subject = subject;
    this.predicate = predicate;
    this.object = object;
    this.datatype = datatype;
  }

  isEqual(other) {
    return (
      this.subject == other.subject &&
      this.predicate == other.predicate &&
      this.object == other.object &&
      this.datatype == other.datatype
    );
  }

  toNT() {
    const predicate =
      this.predicate == 'a' ? this.predicate : sparqlEscapeUri(this.predicate);
    let object;
    if (this.datatype == 'http://www.w3.org/2000/01/rdf-schema#Resource') {
      object = sparqlEscapeUri(this.object);
    } else {
      object = sparqlEscapeString(this.object);
      if (this.datatype) object += `^^${sparqlEscapeUri(this.datatype)}`;
    }
    return `${sparqlEscapeUri(this.subject)} ${predicate} ${object} .`;
  }
}
