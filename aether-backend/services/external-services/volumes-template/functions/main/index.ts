Deno.serve(async (req) => {
  return new Response(
    JSON.stringify({ message: "Aether Edge Functions Ready" }),
    { headers: { "Content-Type": "application/json" } },
  )
})