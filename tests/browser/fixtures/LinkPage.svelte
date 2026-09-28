<script>
import { Link } from "../../../src/client/svelte/index.js";
</script>

<Link href="/search" data={{ q: "tea" }}>search</Link>
<Link href="/orders/1" method="delete" data={{ reason: "dup" }}>delete</Link>
