import React from 'react';
import { TodoItem } from '../types/index.js';

interface TodoListProps {
  todos: TodoItem[];
}

export const TodoList: React.FC<TodoListProps> = ({ todos }) => {
  return (
    <div className="forge-card">
      <div className="card-title">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>📋</span>
          <span>Task Progress / TODO</span>
        </div>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {todos.filter((t) => t.done).length} / {todos.length} Done
        </span>
      </div>

      {todos.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '8px 0' }}>
          No active checklist items. Use the todo tool in tasks to display progress here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {todos.map((t) => (
            <div
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '8px 12px',
                background: 'var(--bg-input)',
                borderRadius: '6px',
                border: '1px solid var(--border-subtle)',
                fontSize: '0.9rem',
                color: t.done ? 'var(--text-muted)' : 'var(--text-primary)',
                textDecoration: t.done ? 'line-through' : 'none'
              }}
            >
              <span style={{ color: t.done ? 'var(--green)' : 'var(--yellow)', fontWeight: 'bold' }}>
                {t.done ? '✓' : '○'}
              </span>
              <span>{t.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
