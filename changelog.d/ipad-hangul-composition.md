### Fixed
- Korean typed on an iPad with a hardware keyboard (Magic Keyboard) reaches the terminal as whole
  syllables again. iPadOS Safari sent each jamo as its own key, so 한 arrived as ㅎㅏㄴ; the
  terminal now lets the iPad compose the syllable and sends it once, before the next key.
- The syllable being typed in the terminal is drawn at the size of the ones already typed. On Apple
  devices the terminal enlarges Hangul to fill its two cells, but the box that shows the pending
  syllable kept the plain size, so the last syllable looked smaller until it was committed.
