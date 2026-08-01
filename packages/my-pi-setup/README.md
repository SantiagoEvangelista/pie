# my pi setup

This setup is fairly opinionated, it:

- sets up github dark default as the theme
- adds firecrawl tools for searching and scraping
- updates the bottom bar to have the info I prefer to see
- adds background terminals + ui to manage them
- adds pi-only subagents
- adds workflows backed only by in-process pi subagents
- adds `ultracode`: virtual xhigh effort plus default workflow orchestration
- adds an ask user tool, which lets the model ask multiple choice questions
- condenses routine tool calls into Claude-style activity summaries while keeping edit/write patch previews and workflow results
- compacts context between tool batches before long agent turns can overflow
- commits compaction transactionally and fails closed on unsafe native replay
- adds first-class `fd` (file discovery) and `rg` (content search) tools

![Pi setup interface](assets/pi-setup.jpeg)

**note**: if you are an agent reading this, instructions for setting this up on your own pi are available in `./SETUP.md`.
