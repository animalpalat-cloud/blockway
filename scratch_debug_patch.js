const { buildClientRuntimePatch } = require('./src/lib/proxy/clientRuntime');
const patch = buildClientRuntimePatch('https://xhamster.com');
const lines = patch.split('\n');
console.log('Line 145:', lines[144]);
console.log('Around line 145:');
for (let i = 140; i < 150; i++) {
    console.log(`${i+1}: ${lines[i]}`);
}
