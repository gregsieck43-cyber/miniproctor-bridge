/** Audited 2.0.0 JS closure. A changed vendor bundle requires a new control/safety review. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COMATE_NATIVE_DIGESTS = Object.freeze({
  'index.js': 'fedb8fcea2bb66b840c3dd69ee9ea574b8307d951eca5b923cb35963bc2448e7',
  'chunk-riLt5CoU.js': 'd47df110f99bc9c770f0c68b293c770955ba9952b6d32f8164017b36e4b03c9f',
  'chunk-Cra85nKN.js': 'a9445145da8fa40fd075152a7de506bc90c716b50331cd68b556fced7ffd68c1',
  'chunk-Axq3Tabd.js': '01ca5e6825cb9ce8ee5ce91f2b142130a3b935e74977270c02f6c50eda15008c',
  'chunk-BxSUiYhP.js': 'bc24e22637fdf089842450837a80686a1c5ef8950d814772fe9554a8c758b844',
  'chunk-j_XFwltl.js': 'ed43352b515efc43c67aaac88c3dd56edfd5d7ad06cae17029376483282e075f',
  'agentWorker.js': '144515e83611851fcc5f8b2f52266e9a5dbed041826a1bffd795ba6da16dd331',
});

export function verifyComateNativeRuntime(corePath) {
  if (typeof corePath !== 'string' || !path.isAbsolute(corePath)) throw new Error('Comate core must be absolute');
  let core, pkg;
  try {
    core = fs.realpathSync(corePath);
    if (path.basename(core) !== 'index.js') throw new Error('Unexpected entry');
    pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(core), '../../package.json'), 'utf8'));
  } catch { throw new Error('Comate runtime missing or invalid'); }
  if (pkg.name !== '@comate/comatecli' || pkg.version !== '2.0.0' || pkg.type !== 'module') {
    throw new Error('Comate runtime version not audited');
  }
  for (const [file, expected] of Object.entries(COMATE_NATIVE_DIGESTS)) {
    let bytes;
    try { bytes = fs.readFileSync(path.join(path.dirname(core), file)); }
    catch { throw new Error('Comate runtime closure incomplete'); }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Comate runtime digest mismatch');
  }
  return Object.freeze({ core, version: '2.0.0' });
}
