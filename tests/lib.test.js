const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib.js');

test('scaleIngredient handles fractions, ranges, mixed numbers', () => {
  assert.equal(L.scaleIngredient('1 1/2 cups flour', 2), '3 cups flour');
  assert.equal(L.scaleIngredient('½ tsp salt', 2), '1 tsp salt');
  assert.equal(L.scaleIngredient('2-3 cloves garlic', 2), '4-6 cloves garlic');
  assert.equal(L.scaleIngredient('1 cup milk', 0.5), '½ cup milk');
  assert.equal(L.scaleIngredient('1 cup milk', 1 / 3), '⅓ cup milk');
  assert.equal(L.scaleIngredient('Salt to taste', 2), 'Salt to taste');
  assert.equal(L.scaleIngredient('2 tomatoes', 2), '4 tomatoes');
  assert.equal(L.scaleIngredient('1 ½ cups water', 2), '3 cups water');
  assert.equal(L.scaleIngredient('200 g butter', 1.5), '300 g butter');
});

test('durations', () => {
  assert.equal(L.durationToMin('PT1H30M'), 90);
  assert.equal(L.durationToMin('PT45M'), 45);
  assert.equal(L.fmtMin(90), '1 hr 30 min');
  assert.equal(L.fmtMin(0), '');
});

test('JSON-LD recipe incl. @graph, HowToSection, entities', () => {
  const ld = [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, {
    '@type': ['Recipe'], name: 'Mom&#039;s Soup', image: ['/img/a.jpg'], recipeYield: ['4', '4 servings'],
    prepTime: 'PT10M', cookTime: 'PT20M', recipeCategory: ['Dinner'], keywords: 'soup, easy',
    recipeIngredient: ['2 carrots', '1 &frac12; cups stock'],
    recipeInstructions: [{ '@type': 'HowToSection', name: 'Main', itemListElement: [{ '@type': 'HowToStep', text: 'Chop.' }, { '@type': 'HowToStep', text: 'Simmer.' }] }]
  }] }];
  const d = L.draftFromLd(ld, 'https://www.example.com/soup');
  assert.equal(d.title, "Mom's Soup");
  assert.equal(d.image, 'https://www.example.com/img/a.jpg');
  assert.equal(d.servings, 4);
  assert.equal(d.prepMin, 10); assert.equal(d.cookMin, 20);
  assert.deepEqual(d.ingredients, ['2 carrots', '1 ½ cups stock']);
  assert.deepEqual(d.steps, ['Chop.', 'Simmer.']);
  assert.ok(d.tags.includes('dinner') && d.tags.includes('soup'));
  assert.equal(d.sourceName, 'example.com');
});

test('string instructions split and unnumber', () => {
  const d = L.draftFromLd({ '@type': 'Recipe', name: 'X', recipeInstructions: '1. Mix.\n2. Bake.' }, '');
  assert.deepEqual(d.steps, ['Mix.', 'Bake.']);
});

test('parseText with headers (typical Instagram caption)', () => {
  const p = L.parseText(`Creamy garlic pasta 🍝 so easy!!\n\n🧄 Ingredients:\n- 200g pasta\n- 3 cloves garlic\n- 1 cup cream\n\n📝 Instructions:\n1. Boil the pasta.\n2. Fry garlic then add cream.\n3. Toss together.\n\n#pasta #easydinner`);
  assert.equal(p.title, 'Creamy garlic pasta  so easy!!'.replace('  ', ' '));
  assert.deepEqual(p.ingredients, ['200g pasta', '3 cloves garlic', '1 cup cream']);
  assert.deepEqual(p.steps, ['Boil the pasta.', 'Fry garlic then add cream.', 'Toss together.']);
  assert.deepEqual(p.tags, ['pasta', 'easydinner']);
});

test('parseText heuristic without headers', () => {
  const p = L.parseText(`Quick pancakes\n1 cup flour\n1 egg\n1 cup milk\nWhisk everything together until smooth.\nCook on a hot pan until golden on both sides.`);
  assert.equal(p.title, 'Quick pancakes');
  assert.equal(p.ingredients.length, 3);
  assert.equal(p.steps.length, 2);
});

test('numbered steps are not mistaken for ingredients', () => {
  const p = L.parseText(`Thing\n2 eggs\n1. Crack the eggs into a bowl and whisk.\n2. Fry them.`);
  assert.deepEqual(p.ingredients, ['2 eggs']);
  assert.equal(p.steps.length, 2);
});

test('cleanSocialCaption strips Instagram boilerplate', () => {
  const s = '12K likes, 80 comments - chef on March 3, 2024: "Ingredients:\n2 eggs\nSteps:\nCook."';
  assert.ok(L.cleanSocialCaption(s).startsWith('Ingredients:'));
  assert.equal(L.cleanSocialCaption('plain text'), 'plain text');
});
