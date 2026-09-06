import { todoStore } from './src/todo.js';

console.log('Testing todoStore...');

// Add a todo
const todo1 = todoStore.add('Learn TypeScript');
console.log('Added:', todo1);

// Add another todo
const todo2 = todoStore.add('Build a todo app');
console.log('Added:', todo2);

// List todos
console.log('All todos:');
console.log(todoStore.list());

// Toggle first todo
const toggled = todoStore.toggleDone(todo1.id);
console.log('Toggled:', toggled);

// List again
console.log('All todos after toggle:');
console.log(todoStore.list());

// Remove second todo
const removed = todoStore.remove(todo2.id);
console.log('Removed second todo:', removed);

// List again
console.log('All todos after removal:');
console.log(todoStore.list());

// Try to remove non-existent todo
const notFound = todoStore.remove(999);
console.log('Try to remove non-existent:', notFound);