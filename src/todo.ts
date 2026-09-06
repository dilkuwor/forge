export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

class TodoStore {
  private todos: Todo[] = [];
  private nextId: number = 1;

  add(text: string): Todo {
    const todo: Todo = {
      id: this.nextId++,
      text,
      done: false,
    };
    this.todos.push(todo);
    return todo;
  }

  list(): Todo[] {
    return [...this.todos];
  }

  remove(id: number): boolean {
    const index = this.todos.findIndex(t => t.id === id);
    if (index === -1) return false;
    this.todos.splice(index, 1);
    return true;
  }

  toggleDone(id: number): Todo | null {
    const todo = this.todos.find(t => t.id === id);
    if (!todo) return null;
    todo.done = !todo.done;
    return todo;
  }
}

// Export a singleton instance for simplicity
export const todoStore = new TodoStore();