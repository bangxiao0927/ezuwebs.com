import assert from "node:assert/strict";
import test from "node:test";

import { initialPropertyValues, propertiesWithValues, withPropertyValue } from "./propertyValues.js";

test("initialPropertyValues seeds one entry per property from its current value", () => {
  const values = initialPropertyValues([
    { key: "title", label: "Title", value: "Hello" },
    { key: "subtitle", label: "Subtitle", value: "World" },
  ]);

  assert.deepEqual(values, { title: "Hello", subtitle: "World" });
});

test("withPropertyValue returns a new object accumulating edits across calls", () => {
  const first = withPropertyValue({}, "title", "Hello");
  const second = withPropertyValue(first, "subtitle", "World");

  assert.deepEqual(second, { title: "Hello", subtitle: "World" });
  assert.deepEqual(first, { title: "Hello" }, "earlier snapshot must stay unmutated");
});

test("propertiesWithValues overrides property values from the accumulated edits", () => {
  const properties = [
    { key: "title", label: "Title", value: "Hello" },
    { key: "subtitle", label: "Subtitle", value: "World" },
  ];
  const values = { title: "Edited title" };

  const merged = propertiesWithValues(properties, values);

  assert.deepEqual(merged, [
    { key: "title", label: "Title", value: "Edited title" },
    { key: "subtitle", label: "Subtitle", value: "World" },
  ]);
});
