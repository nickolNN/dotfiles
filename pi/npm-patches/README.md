# pi npm-patches

`<pkg>/` directories here are merged onto
`~/.pi/agent/npm/node_modules/<pkg>/` inside agent containers at every
spawn/attach (see `dotfiles-agent/attach.sh`). Launch-time merge wins
over the build-time `pi update --extensions` because the sync runs after
container creation. Merge semantics: removing a patch needs cleanup
inside the container (or a fresh volume).
