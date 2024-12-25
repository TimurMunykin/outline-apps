'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');

const tarballBinary = fs.readFileSync(process.argv[2]);
const base64Tarball = tarballBinary.toString('base64');
const scriptText = `
(base64 --decode | tar --extract --gzip ) <<EOM
${base64Tarball}
EOM
./yandex_install_server.sh
`;

console.log(`export const SCRIPT = ${JSON.stringify(scriptText)};`);
