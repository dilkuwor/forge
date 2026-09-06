import fs from 'node:fs';
import path from 'node:path';
import { getForgeDir } from './config.js';

export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

class TodoStore {
  private getFilePath(): string {
    return path.join(getForgeDir(), 'todos.json');
  }

  private load(): { todos: Todo[]; nextId: number } {
    try {
      const file = this.getFilePath();
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.todos)) {
          return {
            todos: data.todos,
            nextId:
              typeof data.nextId === 'number'
                ? data.nextId
                : Math.max(0, ...data.todos.map((t: Todo) => t.id)) + 1
          };
        }
      }
    } catch {}
    return { todos: [], nextId: 1 };
  }

  private save(todos: Todo[], nextId: number): void {
    try {
      const file = this.getFilePath();
      fs.writeFileSync(file, JSON.stringify({ todos, nextId }, null, 2), 'utf8');
    } catch {}
  }

  add(text: string): Todo {
    const { todos, nextId } = this.load();
    const todo: Todo = {
      id: nextId,
      text,
      done: false
    };
    todos.push(todo);
    this.save(todos, nextId + 1);
    return todo;
  }

  list(): Todo[] {
    return this.load().todos;
  }

  remove(id: number): boolean {
    const { todos, nextId } = this.load();
    const index = todos.findIndex((t) => t.id === id);
    if (index === -1) return false;
    todos.splice(index, 1);
    this.save(todos, nextId);
    return true;
  }

  toggleDone(id: number): Todo | null {
    const { todos, nextId } = this.load();
    const todo = todos.find((t) => t.id === id);
    if (!todo) return null;
    todo.done = !todo.done;
    this.save(todos, nextId);
    return todo;
  }
}

// Export a singleton instance
export const todoStore = new TodoStore();