// Prints one to-do as a line of text.
export function formatTodo(todo: { id: number; title: string; done: boolean }): string {
  return `${todo.done ? "[x]" : "[ ]"} ${todo.id} ${todo.title}`;
}
