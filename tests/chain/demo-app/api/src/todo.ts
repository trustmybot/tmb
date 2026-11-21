// The to-do list's rules. A list is an array; every change returns a new one.

export type Todo = { id: number; title: string; done: boolean };

export function addTodo(list: Todo[], title: string): Todo[] {
  const id = list.reduce((max, todo) => Math.max(max, todo.id), 0) + 1;
  return [...list, { id, title: title.trim(), done: false }];
}

export function completeTodo(list: Todo[], id: number): Todo[] {
  return list.map((todo) => (todo.id === id ? { ...todo, done: true } : todo));
}

export const countOpen = (list: Todo[]): number => list.filter((todo) => !todo.done).length;
