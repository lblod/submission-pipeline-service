import { JSDOM } from 'jsdom';
import { analyse } from '@lblod/marawa/rdfa-context-scanner.js';
import lodash from 'lodash';
import Triple from './triple.js';

// lodash is CommonJS; its named exports can't be imported directly.
const { uniqWith } = lodash;

/**
 * Extracts RDFa from an HTML document with marawa's context scanner. Note that
 * marawa drops language tags; replacing it changes the harvested triples.
 */
class RdfaExtractor {
  constructor(html, documentUrl) {
    this.html = html;
    this.documentUrl = documentUrl;
  }

  rdfa() {
    const dom = new JSDOM(this.html);
    const domNode = dom.window.document.querySelector('body');
    const blocks = analyse(domNode, undefined, {
      documentUrl: this.documentUrl,
    });
    const triples = blocks.flatMap((b) => b.context).map((t) => new Triple(t));
    this.triples = uniqWith(triples, (a, b) => a.isEqual(b));
    return this.triples;
  }

  add(triples) {
    const allTriples = (this.triples || []).concat(triples);
    this.triples = uniqWith(allTriples, (a, b) => a.isEqual(b));
  }

  ttl() {
    if (this.triples === undefined) {
      console.log('No triples found. Did you extract RDFa already?');
      return null;
    }
    return this.triples
      .map((t) => {
        try {
          return t.toNT();
        } catch (e) {
          console.log(
            `rdfa extractor WARNING: invalid statement: <${t.subject}> <${t.predicate}> ${t.object}\n${e}`,
          );
          return '';
        }
      })
      .join('\n');
  }
}

export default RdfaExtractor;
