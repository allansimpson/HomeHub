namespace HomeHub.Api.Meals;

using System.Globalization;
using System.Text.RegularExpressions;

/// <summary>
/// Reads a recipe out of a block of text somebody copied off a page.
/// </summary>
/// <remarks>
/// <b>Why this exists.</b> The URL importer only works where the publisher lets the panel fetch the
/// page. Several large recipe houses do not: every People Inc. property — allrecipes, Serious Eats,
/// Simply Recipes — answers <c>402</c> from Cloudflare to any client, browser user-agent included,
/// with a body pointing at their content-licensing address. That is a deliberate decision by the
/// rights holder and this does not go around it: the household reads the page in their own browser,
/// as an ordinary reader, and pastes what they can already see. Nothing here fetches anything.
/// <para>
/// <b>The parser is the same one.</b> Ingredient lines go through <see cref="IngredientParser"/>,
/// exactly as JSON-LD's do, so a pasted recipe scales the same way an imported one does. This class
/// only decides which lines are ingredients, which are steps, and what the rest of the block was
/// saying — it does no ingredient parsing of its own.
/// </para>
/// <para>
/// <b>Failure is a missing field, never a wrong one</b>, the same rule the ingredient parser
/// follows. A block this cannot section confidently comes back <c>Partial</c> with everything in
/// the ingredient list, where a person can see it and fix it, rather than being silently split
/// down the middle at a guess.
/// </para>
/// </remarks>
public static partial class PastedRecipeImporter
{
    /// <summary>Headings that mean "the ingredient list starts here".</summary>
    private static readonly string[] IngredientHeadings =
        ["ingredients", "ingredient", "you'll need", "you will need", "what you need", "shopping list"];

    /// <summary>Headings that mean "the method starts here".</summary>
    private static readonly string[] StepHeadings =
        ["directions", "direction", "instructions", "instruction", "method", "steps", "preparation",
         "how to make it", "how to make", "to make", "procedure"];

    /// <summary>
    /// Headings that mean "stop — everything after this is not the recipe", matched <b>whole</b>.
    /// </summary>
    /// <remarks>
    /// Copying off a page nearly always drags the tail of the article with it. Cutting at these
    /// keeps a nutrition table and a comment thread out of the method.
    /// <para>
    /// Whole-line for the short ones, because they are ordinary words too: `Tips` ends a recipe,
    /// but `Tips of the asparagus should be trimmed` is step four, and prefix-matching that would
    /// throw away the rest of the method.
    /// </para>
    /// </remarks>
    private static readonly HashSet<string> EndHeadings = new(StringComparer.OrdinalIgnoreCase)
    {
        "nutrition", "notes", "note", "reviews", "comments", "related", "tips", "watch", "video",
        "similar recipes", "you'll also love", "you might also like",
    };

    /// <summary>
    /// Tails that carry more words, so they cannot be matched whole.
    /// </summary>
    /// <remarks>
    /// The print view is why this exists: it prints `Nutrition Facts (per serving)`, which the
    /// whole-line set above misses by four words, and the entire nutrition table then reads as
    /// method. Each of these is long enough that no instruction begins with it.
    /// </remarks>
    private static readonly string[] EndPrefixes =
        ["nutrition facts", "nutrition information", "cook's note", "cooks note", "chef's note",
         "editor's note", "recipe tips", "printed from", "copyright", "all rights reserved",
         "© ", "this recipe was", "originally appeared"];

    /// <summary>
    /// Lines that are page chrome rather than recipe content, matched <b>whole</b>.
    /// </summary>
    /// <remarks>
    /// Whole-line, and that is the point: these were prefix-matched once, which quietly deleted any
    /// step beginning with one of them — `Save the pan drippings`, `Share among four bowls`, `Rate
    /// the oven down to 160`. A word that is chrome on its own line is ordinary English at the start
    /// of a sentence.
    /// <para>
    /// The list is long because a household copies the <b>whole page</b>, not a tidy selection: the
    /// nav, the ad slots and the rating widget all come along. `Ad` is the one that matters most —
    /// it sits directly above the title on allrecipes, and being two characters long it looked
    /// exactly like a recipe name.
    /// </para>
    /// </remarks>
    private static readonly HashSet<string> Chrome = new(StringComparer.OrdinalIgnoreCase)
    {
        // Ad slots — the reason this list exists.
        "ad", "ads", "advertisement", "advertisements", "sponsored", "sponsor", "promoted",
        // Site navigation.
        "skip to content", "skip to main content", "menu", "search", "close", "home", "recipes",
        "log in", "login", "sign in", "sign up", "register", "subscribe", "newsletter", "follow",
        "my account", "account", "profile", "shop", "about us", "contact", "help", "gift",
        // The rating and social widgets.
        "share", "save", "saved", "print", "rate", "rating", "ratings", "review", "reviews",
        "photo", "photos", "video", "videos", "trending videos", "next", "previous", "back",
        "more", "see more", "read more", "show more", "hide", "expand",
        // Recipe-page controls.
        "add to shopping list", "add all ingredients to shopping list", "jump to recipe",
        "jump to nutrition facts", "cook mode", "prevent your screen from going dark",
        "i made it", "original recipe", "made it", "add photo", "add a photo",
    };

    /// <summary>
    /// Chrome that carries a tail, so it cannot be matched whole.
    /// </summary>
    /// <remarks>
    /// Every one of these is several words long and could not begin an instruction, which is what
    /// makes prefix matching safe here and unsafe for the single words above.
    /// </remarks>
    private static readonly string[] ChromePrefixes =
        ["photos of", "prevent your screen", "add all ingredients", "original recipe (",
         "recipe by ", "submitted by ", "updated on ", "published on ", "tested by ",
         "dotdash meredith", "this article", "we independently"];

    /// <summary>
    /// Parse a pasted block. <paramref name="sourceUrl"/> is kept as provenance only — never fetched.
    /// </summary>
    public static RecipeImportResult Parse(string text, string? sourceUrl = null, string? titleHint = null)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new RecipeImportResult(ImportConfidence.Empty, null, null, "There was nothing to read.");

        // The print view prints the page's own address in its footer. When the link box was left
        // empty — which it will be, because the link is what refused to import — that line is the
        // recipe's provenance, so take it before `Clean` drops it.
        sourceUrl ??= FirstUrlIn(text);

        var lines = Clean(text);
        if (lines.Count == 0)
            return new RecipeImportResult(ImportConfidence.Empty, null, null, "There was nothing to read.");

        // Facts first: they are scattered through the block and removing them makes the sectioning
        // that follows deal only with ingredients, steps and headings.
        var servings = ReadServings(lines);
        var (prep, cook, total) = ReadTimes(lines);

        var (ingredientLines, stepLines, title) = Section(lines, titleHint);

        var ingredients = BuildIngredients(ingredientLines);
        var steps = BuildSteps(stepLines);

        // The same bar the JSON-LD importer holds pages to (D10), so a pasted recipe and an imported
        // one mean the same thing by `Complete`.
        var missing = new List<string>();
        if (string.IsNullOrWhiteSpace(title)) missing.Add("a title");
        if (ingredients.Count < 2) missing.Add("its ingredients");
        if (steps.Count == 0) missing.Add("its method");

        if (ingredients.Count == 0 && steps.Count == 0)
        {
            return new RecipeImportResult(
                ImportConfidence.Empty, null, null,
                "That doesn't look like a recipe. Copy the ingredients and the method, and paste both.");
        }

        var input = new RecipeInput(
            // A block with no line that reads as a name still saves — flagged Partial, and named so
            // the row is findable and editable rather than refused outright.
            Title: Trim(title, MealFieldLimits.Title) ?? "Untitled recipe",
            SourceUrl: Trim(sourceUrl, MealFieldLimits.Url),
            SourceName: SourceNameFor(sourceUrl),
            Servings: servings,
            PrepMinutes: prep,
            CookMinutes: cook,
            // Derived only when it was not stated and both halves were. A total that contradicts its
            // own parts is worse than no total.
            TotalMinutes: total ?? (prep is not null && cook is not null ? prep + cook : null),
            Ingredients: ingredients,
            Steps: steps);

        return new RecipeImportResult(
            missing.Count == 0 ? ImportConfidence.Complete : ImportConfidence.Partial,
            input,
            null,
            missing.Count == 0 ? null : $"Pasted, but the panel could not find {Join(missing)}.");
    }

    /// <summary>Trim, drop blanks, drop page furniture, and stop at the article's tail.</summary>
    private static List<string> Clean(string text)
    {
        var raw = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var kept = new List<string>();

        foreach (var line in raw)
        {
            // Non-breaking spaces arrive constantly from copied HTML and would defeat every trim and
            // every regex below.
            var trimmed = line.Replace(' ', ' ').Trim();
            if (trimmed.Length == 0) continue;
            // Bullets, dashes and the checkbox glyphs a print view puts beside every ingredient.
            // Stripped before anything else reads the line: to the ingredient parser, `▢ 1 pound
            // ground beef` has no leading amount at all, so the whole line would go unparsed — and
            // an unparsed line is one that will not scale.
            trimmed = LeadingMarker().Replace(trimmed, string.Empty).Trim();
            if (trimmed.Length == 0) continue;

            var bare = Bare(trimmed);
            if (EndHeadings.Contains(bare) || EndPrefixes.Any(p => bare.StartsWith(p, StringComparison.Ordinal))) break;
            if (IsChrome(bare)) continue;
            // A lone bullet or rule left over from the copy.
            if (trimmed.All(c => !char.IsLetterOrDigit(c))) continue;
            // The rating widget: `4.6`, `(1,234)`, `1,234 Ratings`, `4.6 out of 5`.
            if (RatingLine().IsMatch(trimmed)) continue;
            // A bare address on its own line — the print view's footer. Taken as provenance in
            // `Parse` before this point, so dropping it here loses nothing.
            if (BareUrl().IsMatch(trimmed)) continue;

            kept.Add(trimmed);
        }

        return kept;
    }

    /// <summary>
    /// Split the block into ingredients and steps, and pull a title off the top if there is one.
    /// </summary>
    /// <remarks>
    /// Two strategies, in order of how much they can be trusted.
    /// <list type="number">
    /// <item><b>Explicit headings.</b> If the block says `Ingredients` and `Directions`, believe it.
    /// This is the common case, because those words come along with the copy.</item>
    /// <item><b>Shape.</b> With no headings, the split is the point where short amount-led lines give
    /// way to prose. Ingredients are short and start with a number; steps are sentences.</item>
    /// </list>
    /// </remarks>
    private static (List<string> Ingredients, List<string> Steps, string? Title) Section(
        List<string> lines, string? titleHint)
    {
        var ingredientStart = -1;
        var stepStart = -1;

        for (var i = 0; i < lines.Count; i++)
        {
            var bare = Bare(lines[i]);
            if (ingredientStart < 0 && IngredientHeadings.Contains(bare)) ingredientStart = i + 1;
            else if (stepStart < 0 && StepHeadings.Contains(bare)) stepStart = i + 1;
        }

        // One boundary for both strategies: everything above it is the page, not the recipe.
        var recipeStart = RecipeStartsAt(lines);
        var title = Blank(titleHint) ?? TitleFrom(lines, recipeStart);

        if (ingredientStart >= 0 || stepStart >= 0)
        {
            var ingredients = ingredientStart < 0
                ? []
                : Slice(lines, ingredientStart, stepStart > ingredientStart ? stepStart - 1 : lines.Count);
            var steps = stepStart < 0
                ? []
                : Slice(lines, stepStart, ingredientStart > stepStart ? ingredientStart - 1 : lines.Count);

            // A method heading with no ingredients heading: whatever sits between the recipe's start
            // and that heading is the ingredient list.
            if (stepStart >= 0 && ingredientStart < 0)
                ingredients = Slice(lines, recipeStart, stepStart - 1);

            return (ingredients, steps, title);
        }

        // ---- No headings. Split on shape. ----
        // Start where the recipe does, so a whole-page copy's nav does not become its first
        // ingredient.
        var start = recipeStart;

        // The first line that reads as prose *and* is followed by more prose. One long ingredient
        // ("2 pounds beef chuck, cut into 1-inch cubes and patted thoroughly dry") must not be
        // mistaken for the start of the method.
        var split = lines.Count;
        for (var i = start; i < lines.Count; i++)
        {
            if (!LooksLikeStep(lines[i])) continue;
            var next = i + 1 < lines.Count ? LooksLikeStep(lines[i + 1]) : true;
            if (next) { split = i; break; }
        }

        return (Slice(lines, start, split), Slice(lines, split, lines.Count), title);
    }

    private static List<string> Slice(List<string> lines, int from, int toExclusive)
    {
        from = Math.Max(0, from);
        toExclusive = Math.Min(lines.Count, toExclusive);
        return from >= toExclusive ? [] : lines.GetRange(from, toExclusive - from);
    }

    /// <summary>
    /// Prose, rather than an ingredient.
    /// </summary>
    /// <remarks>
    /// Amount-led lines are ingredients however long they run, which is the important half of this:
    /// the parser can read them, and a line it can read is not a sentence. Everything else falls back
    /// to length and sentence punctuation.
    /// </remarks>
    private static bool LooksLikeStep(string line)
    {
        if (StepNumber().IsMatch(line)) return true;
        if (IngredientParser.Parse(line).Quantity is not null) return false;

        var words = line.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
        // Twelve words with a full stop is a sentence; "Salt and pepper to taste" is not.
        return words >= 12 || (words >= 8 && line.EndsWith('.'));
    }

    /// <summary>
    /// Where the recipe proper begins: the first heading, stated fact, or amount-led line.
    /// </summary>
    /// <remarks>
    /// Everything above this is the page around the recipe — nav, ad slots, the byline. Finding the
    /// boundary once lets the title search look only where a title could be, and lets a headingless
    /// block start its ingredients past the furniture rather than at line zero.
    /// </remarks>
    private static int RecipeStartsAt(List<string> lines)
    {
        for (var i = 0; i < lines.Count; i++)
        {
            var bare = Bare(lines[i]);
            if (IngredientHeadings.Contains(bare) || StepHeadings.Contains(bare)) return i;
            if (FactLine().IsMatch(lines[i])) return i;
            if (IngredientParser.Parse(lines[i]).Quantity is not null) return i;
        }
        return lines.Count;
    }

    /// <summary>
    /// The recipe's name, taken as the <b>last</b> plausible line before the recipe begins.
    /// </summary>
    /// <remarks>
    /// <b>Last, not first, and that is the whole trick.</b> A tidy copy has exactly one candidate, so
    /// the two agree. A whole-page copy has the site's nav above the title — `Skip to content`,
    /// `Allrecipes`, `Ad` — and taking the first named the recipe after whichever of those survived
    /// filtering. Chasing that with a list of site names is unwinnable; there are thousands of
    /// recipe sites and one of them is called almost anything. Position is the reliable signal: the
    /// title is the thing sitting immediately above the ingredients, whatever came before it.
    /// <para>
    /// The three-character floor caught `Ad`, which is what was reported. It stays, but the
    /// positional rule is what actually settles this.
    /// </para>
    /// </remarks>
    private static string? TitleFrom(List<string> lines, int limit)
    {
        string? best = null;
        for (var i = 0; i < Math.Min(limit, lines.Count); i++)
        {
            var line = lines[i];
            if (line.Length is < 3 or > 120) continue;
            if (IsChrome(Bare(line))) continue;
            if (IngredientParser.Parse(line).Quantity is not null) continue;
            if (line.EndsWith(':')) continue;
            if (Bare(line) is var bare && (IngredientHeadings.Contains(bare) || StepHeadings.Contains(bare))) continue;
            if (FactLine().IsMatch(line)) continue;
            if (RatingLine().IsMatch(line)) continue;
            // Needs a letter: `(1,234)` and `4.6` are the rating widget, not a name.
            if (!line.Any(char.IsLetter)) continue;
            // A sentence is the standfirst under the title, not the title. Recipes are not named
            // "A quick homemade blend of chili powder and cumin."
            if (line.EndsWith('.') || line.EndsWith('!') || line.EndsWith('?')) continue;
            best = line;
        }
        return best;
    }

    /// <summary>Page chrome — matched whole, or by one of the unambiguous multi-word prefixes.</summary>
    private static bool IsChrome(string bare) =>
        Chrome.Contains(bare) || ChromePrefixes.Any(p => bare.StartsWith(p, StringComparison.Ordinal));

    /// <summary>
    /// Ingredient lines, parsed, with `For the sauce:` style sub-headings carried onto what follows.
    /// </summary>
    private static List<RecipeIngredientInput> BuildIngredients(List<string> lines)
    {
        var output = new List<RecipeIngredientInput>();
        string? heading = null;

        foreach (var line in lines)
        {
            // A heading is a colon-terminated line with no amount in it. "1 cup milk:" is not one.
            if (line.EndsWith(':') && IngredientParser.Parse(line).Quantity is null && line.Length <= MealFieldLimits.SectionHeading)
            {
                heading = line.TrimEnd(':').Trim();
                continue;
            }
            if (FactLine().IsMatch(line)) continue;

            var parsed = IngredientParser.Parse(line);
            output.Add(new RecipeIngredientInput(
                Trim(line, MealFieldLimits.IngredientRawText)!,
                parsed.Quantity,
                Trim(parsed.Unit, MealFieldLimits.Unit),
                Trim(parsed.Name, MealFieldLimits.IngredientName),
                Trim(parsed.Note, MealFieldLimits.Note),
                Trim(heading, MealFieldLimits.SectionHeading)));
        }

        return output;
    }

    /// <summary>
    /// Steps, with their numbering stripped.
    /// </summary>
    /// <remarks>
    /// `Step 1`, `1.` and `1)` are the page's own list markup, not part of the instruction. Left in,
    /// they would be numbered twice on the cook view — once by the copy and once by the renderer.
    /// A standalone `Step 3` line (allrecipes emits these) is dropped entirely.
    /// </remarks>
    private static List<RecipeStepInput> BuildSteps(List<string> lines)
    {
        var output = new List<RecipeStepInput>();
        string? heading = null;

        foreach (var line in lines)
        {
            if (StandaloneStepNumber().IsMatch(line)) continue;
            if (FactLine().IsMatch(line)) continue;

            var text = StepNumber().Replace(line, string.Empty).Trim();
            if (text.Length == 0) continue;

            if (text.EndsWith(':') && text.Length <= MealFieldLimits.SectionHeading
                && text.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length <= 6)
            {
                heading = text.TrimEnd(':').Trim();
                continue;
            }

            output.Add(new RecipeStepInput(
                Trim(text, MealFieldLimits.StepText)!,
                Trim(heading, MealFieldLimits.SectionHeading)));
        }

        return output;
    }

    /// <summary>`Servings: 8`, `Yield: 12 cookies`, `Makes 4 burgers`, `Serves 6`.</summary>
    private static int? ReadServings(List<string> lines)
    {
        foreach (var line in lines)
        {
            // Both orders: `Servings: 8` on the page, `8 servings` in its print view.
            var match = ServingsLine().Match(line);
            if (!match.Success) match = ServingsFirst().Match(line);
            if (match.Success && int.TryParse(match.Groups[1].Value, out var n) && n is > 0 and <= 500) return n;
        }
        return null;
    }

    /// <summary>`Prep Time: 15 mins`, `Cook Time: 1 hr 10 mins`, `Total Time: 1 hr 25 mins`.</summary>
    private static (int? Prep, int? Cook, int? Total) ReadTimes(List<string> lines)
    {
        int? prep = null, cook = null, total = null;
        foreach (var line in lines)
        {
            var match = TimeLine().Match(line);
            if (!match.Success) continue;

            var minutes = Minutes(match.Groups["value"].Value);
            if (minutes is null) continue;

            switch (match.Groups["kind"].Value.ToLowerInvariant())
            {
                case "prep": prep ??= minutes; break;
                case "cook":
                case "bake":
                case "grill":
                case "roast": cook ??= minutes; break;
                case "total": total ??= minutes; break;
            }
        }
        return (prep, cook, total);
    }

    /// <summary>`1 hr 25 mins` / `90 minutes` / `2 hours` → minutes.</summary>
    private static int? Minutes(string value)
    {
        var minutes = 0;
        var found = false;
        foreach (Match part in DurationPart().Matches(value))
        {
            if (!int.TryParse(part.Groups["n"].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)) continue;
            var unit = part.Groups["u"].Value.ToLowerInvariant();
            minutes += unit.StartsWith('h') ? n * 60 : unit.StartsWith('d') ? n * 1440 : n;
            found = true;
        }
        return found && minutes is > 0 and <= 60 * 24 * 7 ? minutes : null;
    }

    /// <summary>The first web address in the block, for when the link box was left empty.</summary>
    private static string? FirstUrlIn(string text)
    {
        var match = AnyUrl().Match(text);
        return match.Success && match.Value.Length <= MealFieldLimits.Url ? match.Value : null;
    }

    /// <summary>`allrecipes.com` off a URL, for the attribution line. Null when there is no URL.</summary>
    private static string? SourceNameFor(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return null;
        var host = uri.Host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? uri.Host[4..] : uri.Host;
        return Trim(host, MealFieldLimits.SourceName);
    }

    /// <summary>Lowercased, stripped of trailing punctuation — for matching a line against a heading.</summary>
    private static string Bare(string line) =>
        line.Trim().TrimEnd(':', '.', '—', '-').Trim().ToLowerInvariant();

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string? Trim(string? value, int max)
    {
        var trimmed = Blank(value);
        return trimmed is null ? null : trimmed.Length <= max ? trimmed : trimmed[..max];
    }

    private static string Join(List<string> parts) => parts.Count switch
    {
        1 => parts[0],
        2 => $"{parts[0]} or {parts[1]}",
        _ => $"{string.Join(", ", parts.Take(parts.Count - 1))} or {parts[^1]}",
    };

    /// <summary>A leading `Step 4`, `1.`, `1)` or `1 -` on an instruction.</summary>
    [GeneratedRegex(@"^\s*(?:step\s*)?\d{1,2}\s*[\.\)\-:]\s*|^\s*step\s+\d{1,2}\s+", RegexOptions.IgnoreCase)]
    private static partial Regex StepNumber();

    /// <summary>A line that is only `Step 4` — the page's list marker on its own line.</summary>
    [GeneratedRegex(@"^\s*step\s*\d{1,2}\s*[\.\):]?\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex StandaloneStepNumber();

    /// <summary>`Servings: 8` / `Serves 6` / `Makes 12 cookies` / `Yield: 4 burgers`.</summary>
    [GeneratedRegex(@"^\s*(?:servings?|serves|makes|yields?)\s*:?\s*(\d{1,3})\b", RegexOptions.IgnoreCase)]
    private static partial Regex ServingsLine();

    /// <summary>`8 servings` — the other way round, which is how a print view usually sets it.</summary>
    [GeneratedRegex(@"^\s*(\d{1,3})\s+servings?\b", RegexOptions.IgnoreCase)]
    private static partial Regex ServingsFirst();

    /// <summary>
    /// A list marker: bullets, dashes, and the checkboxes a print view puts beside each ingredient.
    /// </summary>
    /// <remarks>
    /// Not `\d.` — that is step numbering, which <see cref="StepNumber"/> owns and which must not be
    /// stripped from an ingredient line, where a leading number is the amount.
    /// </remarks>
    [GeneratedRegex(@"^[•‣⁃∙▪▫■□▢○●▸▹☐☑☒·–—*+\-❑❏]+\s*")]
    private static partial Regex LeadingMarker();

    /// <summary>A line that is nothing but a web address — the print view's footer.</summary>
    [GeneratedRegex(@"^\s*(?:https?://|www\.)\S+\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex BareUrl();

    /// <summary>The first address anywhere in the block, used only when none was supplied.</summary>
    [GeneratedRegex(@"https?://[^\s""'<>]+", RegexOptions.IgnoreCase)]
    private static partial Regex AnyUrl();

    /// <summary>`Prep Time: 15 mins` and its relatives.</summary>
    [GeneratedRegex(@"^\s*(?<kind>prep|cook|bake|grill|roast|total|additional|stand|chill|rest)\s*time\s*:?\s*(?<value>.+)$", RegexOptions.IgnoreCase)]
    private static partial Regex TimeLine();

    /// <summary>One `2 hrs` / `25 mins` clause inside a duration.</summary>
    [GeneratedRegex(@"(?<n>\d{1,4})\s*(?<u>d(?:ays?)?|h(?:rs?|ours?)?|m(?:ins?|inutes?)?)\b", RegexOptions.IgnoreCase)]
    private static partial Regex DurationPart();

    /// <summary>
    /// A metadata line rather than recipe content — the servings/time rows the copy drags in.
    /// </summary>
    /// <remarks>
    /// Matched again when building the lists, because those rows sit *inside* the copied block
    /// (between the title and the ingredients on allrecipes) and would otherwise be saved as an
    /// ingredient called "Prep Time".
    /// </remarks>
    [GeneratedRegex(@"^\s*(?:servings?|serves|makes|yields?|(?:prep|cook|bake|grill|roast|total|additional|stand|chill|rest)\s*time)\s*:?\s*\S|^\s*\d{1,3}\s+servings?\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex FactLine();

    /// <summary>
    /// The rating widget, which a whole-page copy always brings: `4.6`, `(1,234)`, `1,234 Ratings`,
    /// `4.6 out of 5 stars`, `12 Reviews`.
    /// </summary>
    /// <remarks>
    /// Left in, `4.6` reads to the ingredient parser as a quantity and lands on the shelf list as an
    /// ingredient with no name.
    /// </remarks>
    [GeneratedRegex(
        @"^\s*\(?\d[\d,\.]*\)?\s*(?:out of\s*\d+\s*)?(?:stars?|ratings?|reviews?|votes?)?\s*$|^\s*\d[\d,\.]*\s*(?:ratings?|reviews?|votes?|stars?)\b",
        RegexOptions.IgnoreCase)]
    private static partial Regex RatingLine();
}
