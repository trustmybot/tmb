// Answers the api's requests over a list kept in memory.
import { formatTodo } from "@todo/format";
import { addTodo, completeTodo, countOpen, type Todo } from "@/index";

let list: Todo[] = [];

export function handle(method: string, body: string): string {
  if (method === "POST") list = addTodo(list, body);
  else if (method === "PATCH") list = completeTodo(list, Number(body));
  return [...list.map(formatTodo), `${countOpen(list)} open`].join("\n");
}

export function reset(): void {
  list = [];
}
