import type { ToolUseContext } from '../../Tool.js'
import type { TodoList } from './types.js'

export function activeTodos(todos: TodoList): TodoList {
  return todos.every(todo => todo.status === 'completed') ? [] : todos
}

export function writeTodos(
  context: Pick<ToolUseContext, 'getAppState' | 'setAppState'>,
  todoKey: string,
  todos: TodoList,
): TodoList {
  const oldTodos = context.getAppState().todos[todoKey] ?? []
  context.setAppState(prev => ({
    ...prev,
    todos: { ...prev.todos, [todoKey]: activeTodos(todos) },
  }))
  return oldTodos
}
