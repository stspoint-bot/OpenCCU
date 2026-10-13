'use strict';

/** Homematic LEVEL is FLOAT even when its value is exactly zero or one.
 * Keep ordinary integer parameters and the BIN-RPC transport unchanged.
 * Convert only at the XML transport boundary, after queueing numeric values.
 */
function parameters(xmlrpc, method, params) {
  if (method !== 'setValue' || !Array.isArray(params) || params.length !== 3 || params[1] !== 'LEVEL') return params;
  const value = params[2];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('LEVEL must be a finite number between zero and one');
  }
  const typed = new xmlrpc.CustomType(value);
  typed.tagName = 'double';
  return [params[0], params[1], typed];
}

module.exports = { parameters };
