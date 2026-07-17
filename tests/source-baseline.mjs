import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';

const expected = new Map([
    ['index.html', '332e1dbf57a814029c9f3d5b0780ab72753f0ed326145fce4530ee0e6a9b875f'],
    ['assets/css/styles.css', '237183cadf9eb790a30880e00a78f415270b32c8074047c34d2ff24dc7140563'],
    ['assets/js/card-utils.js', '2ff9991a9086e0190234a04ed3f9c8383e66118a9bdc7e172c8ff49ead53d3d3'],
    ['assets/js/app.js', '34a0e0c493227d46580506ce0b3a464d90f8234220e51e761deccc4c4b5cb1a7'],
    ['assets/js/ui-select.js', '81dd3838bf096de5b3e9e7acd279ba31fff2052dd36a855a9962f9e5232be6e6'],
    ['assets/js/utils.js', '44139c23d5aed64ca77604b6f29c1f413c4bb962d116c4f30c7dd89f9674cc0a'],
    ['LICENSE', '3997ff7102b0f416eb512c3a3e7c7ee91a00eac32a9af41b21bd82039706c2dc']
]);

for (const [file, expectedHash] of expected) {
    const content = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const actualHash = createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
    if (actualHash !== expectedHash) {
        throw new Error(`${file} no longer matches the RP-Hub 1.7.6 baseline`);
    }
}

try {
    await access(new URL('../character/index.html', import.meta.url));
    throw new Error('character/index.html must not be shipped because the 1.7.6 source contains a hard-coded API key');
} catch (error) {
    if (error?.code !== 'ENOENT') throw error;
}

console.log('RP-Hub 1.7.6 baseline check passed');
