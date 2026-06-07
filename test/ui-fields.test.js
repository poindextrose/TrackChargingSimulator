const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('layout shell has the input bar, three card slots, and overlay', () => {
  assert.ok(/id="inputs"/.test(html));
  assert.ok(/id="cards"/.test(html));
  assert.ok(/id="overlay"/.test(html));
  ['cardA', 'cardB', 'cardC'].forEach(function (id) {
    assert.ok(new RegExp('id="' + id + '"').test(html), id + ' present');
  });
});
