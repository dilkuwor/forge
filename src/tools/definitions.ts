export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read contents of a file within the project. Supports optional line ranges (1-indexed).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from the project root.'
          },
          start: {
            type: 'integer',
            description: 'Optional 1-indexed start line number.'
          },
          end: {
            type: 'integer',
            description: 'Optional 1-indexed end line number.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write entire content to a file. Overwrites existing files or creates new files. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file.'
          },
          content: {
            type: 'string',
            description: 'Full text content to write to the file.'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact unique occurrence of `old` string with `new` string in a file. Fails if `old` is missing or not unique.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file.'
          },
          old: {
            type: 'string',
            description: 'The exact string to be replaced. Must appear exactly once in the file.'
          },
          new: {
            type: 'string',
            description: 'The replacement string.'
          }
        },
        required: ['path', 'old', 'new']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List contents of a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to directory. Defaults to "." (project root).'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.js").',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to search for.'
          }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for text pattern in project files using ripgrep if available, otherwise native search.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Text or regex pattern to search for.'
          },
          glob: {
            type: 'string',
            description: 'Optional glob pattern to restrict search (e.g. "*.ts").'
          }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command in the project root with a 60-second timeout. Read-only commands (ls, pwd, rg, git status, git diff, npm test, npx vitest) are pre-approved. Dangerous commands are blocked.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command line to execute.'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo',
      description: 'Track, add, or update task items to organize multi-step work.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'string'
            },
            description: 'List of todo task items or status updates.'
          }
        },
        required: ['items']
      }
    }
  }
];
