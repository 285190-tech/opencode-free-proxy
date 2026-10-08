fetch("http://de3.bot-hosting.cloud:26043/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer oc-a603bbf69910ed2cccf0a6cbf401fdb78451b7fe"
  },
  body: JSON.stringify({
    model: "big-pickle",
    messages: [{ role: "user", content: "hi" }],
    stream: false
  })
}).then(async r => console.log(r.status, await r.text()))
