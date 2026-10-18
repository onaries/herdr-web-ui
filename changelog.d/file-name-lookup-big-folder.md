### Fixed
- A file named without its folders now opens, and shows in the file search, in a folder that
  also holds thousands of files (a downloaded data set): the lookup reads the whole git file list
  first, and the folder walk no longer lets one large folder use up its 5,000 entries.
