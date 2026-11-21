import { expect, test } from "bun:test";
import { addTodo, completeTodo, countOpen } from "../src/todo";

test("a new to-do is open and gets the next id", () => {
  const list = addTodo(addTodo([], "milk"), " eggs ");
  expect(list).toEqual([
    { id: 1, title: "milk", done: false },
    { id: 2, title: "eggs", done: false },
  ]);
  expect(countOpen(list)).toBe(2);
});

test("a completed to-do is no longer open", () => {
  const list = completeTodo(addTodo([], "milk"), 1);
  expect(countOpen(list)).toBe(0);
});
