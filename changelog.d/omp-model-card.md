### Added
- omp's model picker shows in the chat as a card, as Claude Code's, Codex's and OmO's lists do: pick
  a model and it is picked for the session, the model in use named on the card. `/model` sent from
  an omp chat opens it: the chat sends it as `/switch`, because omp's own `/model` opens its role
  hub, whose picks are saved as the default for later sessions.
