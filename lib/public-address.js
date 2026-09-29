import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';

/**
 * Keeps outgoing requests driven by request input away from the stack's own services
 * and other internal hosts, by the address a host resolves to.
 */

const internal = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  internal.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  // IPv4-mapped and NAT64: can reach IPv4 hosts the list above blocks
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  internal.addSubnet(address, prefix, 'ipv6');
}

/** @param {string} address an IPv4 or IPv6 address */
export function isInternalAddress(address) {
  const family = isIP(address);
  if (!family) return true;
  return internal.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Drop-in for `dns.lookup` that fails for internal addresses. Pass it as the
 * `lookup` option of an http(s) request so the check applies to the address that is
 * actually connected to.
 */
export function publicLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const blocked = addresses.find((a) => isInternalAddress(a.address));
    if (blocked) {
      return callback(
        new Error(`${hostname} resolves to internal address ${blocked.address}`),
      );
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}
