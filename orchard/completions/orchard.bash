_orchard_completion() {
  COMPREPLY=()

  if ((COMP_CWORD > 3)); then
    return
  fi

  local current="${COMP_WORDS[COMP_CWORD]}"
  local command_name=""
  if ((COMP_CWORD == 2)); then
    command_name="${COMP_WORDS[1]}"
  elif ((COMP_CWORD == 3)) && [[ "${COMP_WORDS[1]}" == "deliver" && "${COMP_WORDS[2]}" == "--finalize" ]]; then
    command_name="deliver"
  elif ((COMP_CWORD != 1)); then
    return
  fi

  local candidate
  while IFS= read -r candidate; do
    if [[ -n "$candidate" && "$candidate" == "$current"* ]]; then
      COMPREPLY+=("$candidate")
    fi
  done < <(command orchard __complete "$command_name" 2>/dev/null)
}

complete -F _orchard_completion orchard
