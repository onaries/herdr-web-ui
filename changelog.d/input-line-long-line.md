### Fixed
- A one-line message of more than 200 characters sent from the terminal's input line reaches the pane's
  agent whole: it goes as the agent's prompt, pasted in the agent's own paste mode, where typing it left
  Claude Code with only its tail. A shorter line, and any line to a pane whose agent is waiting for an
  answer or that runs no agent, is still typed.
