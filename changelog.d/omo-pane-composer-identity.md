### Fixed
- A pane that runs OmO is now treated as OmO by the composer even while herdr labels it Claude
  (OmO's Claude child is running): sending a message no longer stops on a Claude input-box draft
  refusal or tries to clear a Claude draft there.
- A multi-line message sent to an OmO pane that herdr has no agent label for is now pasted as one
  bracketed paste instead of line by line, so its first line is no longer sent alone.
