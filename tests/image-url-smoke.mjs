const replacement = '<img src="https://rp.example.com/generate?tag=$1&token=TEST-TOKEN&character_name=Alice&model=test">';
const prompt = '1girl & blue # sky + smile? 100%';
const html = String(replacement).replace(
    'tag=$1&',
    `tag=${encodeURIComponent(prompt.trim())}&`
);
const source = html.match(/src="([^"]+)"/)?.[1];

if (!source) throw new Error('patched image HTML did not contain a source URL');

const url = new URL(source);
if (url.searchParams.get('tag') !== prompt) throw new Error('image prompt did not survive URL encoding');
if (url.searchParams.get('token') !== 'TEST-TOKEN') throw new Error('image token was lost after prompt encoding');
if (url.searchParams.get('character_name') !== 'Alice') throw new Error('character name was lost after prompt encoding');
if (url.hash) throw new Error('image prompt created a URL fragment');
if ([...url.searchParams.keys()].some((name) => !['tag', 'token', 'character_name', 'model'].includes(name))) {
    throw new Error('image prompt created unexpected query parameters');
}

console.log('image URL encoding smoke test passed');
