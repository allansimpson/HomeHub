namespace HomeHub.Tests;

using HomeHub.Api.Calendar;

/// <summary>
/// Classifying an event so a day can carry an icon. The cases that matter are the ones where a
/// confident icon would be wrong — a title *about* a birthday, or a signal Google never gave.
/// </summary>
public class EventKindTests
{
    [Theory]
    [InlineData("birthday", EventKinds.Birthday)]
    [InlineData("outOfOffice", EventKinds.OutOfOffice)]
    [InlineData("focusTime", EventKinds.FocusTime)]
    [InlineData("workingLocation", EventKinds.WorkingLocation)]
    [InlineData("fromGmail", EventKinds.FromGmail)]
    public void Google_event_type_is_believed(string googleType, string expected) =>
        Assert.Equal(expected, EventKinds.Classify(googleType, "primary", "Anything at all"));

    [Fact]
    public void Google_wins_over_the_title()
    {
        // Google says out-of-office; the title happens to mention a birthday. The stated signal holds.
        Assert.Equal(
            EventKinds.OutOfOffice,
            EventKinds.Classify("outOfOffice", "primary", "Off for Dave's birthday"));
    }

    [Fact]
    public void A_holiday_calendar_identifies_its_events()
    {
        Assert.Equal(
            EventKinds.Holiday,
            EventKinds.Classify(null, "en.usa#holiday@group.v.calendar.google.com", "Independence Day"));
    }

    [Theory]
    [InlineData("Bryson Jones Birthday")]
    [InlineData("Jordan Blankman Birthday")]
    [InlineData("Dave's 40th birthday")]
    [InlineData("Birthday: Nan")]
    public void A_hand_typed_birthday_on_an_ordinary_calendar_is_recognised(string title)
    {
        // The real household case: birthdays typed onto the Work calendar, with no Google eventType.
        Assert.Equal(EventKinds.Birthday, EventKinds.Classify(null, "work@example.com", title));
    }

    [Theory]
    [InlineData("Birthday party for Sam")]
    [InlineData("Buy a birthday card")]
    [InlineData("Plan Mum's birthday dinner")]
    [InlineData("Birthday gift shopping")]
    public void An_errand_about_a_birthday_is_not_one(string title)
    {
        // Marking these would put a cake on a day that is not the birthday — worse than no icon.
        Assert.Equal(EventKinds.Default, EventKinds.Classify(null, "work@example.com", title));
    }

    [Fact]
    public void Anniversaries_are_read_from_the_title_too() =>
        Assert.Equal(EventKinds.Anniversary, EventKinds.Classify(null, "primary", "Bob & Ann anniversary"));

    [Fact]
    public void Google_separates_an_anniversary_from_a_birthday()
    {
        var kind = EventKinds.Classify("birthday", "primary", "Bob & Ann");
        Assert.Equal(EventKinds.Anniversary, EventKinds.Refine(kind, "anniversary"));
    }

    [Fact]
    public void A_plain_birthday_stays_a_birthday_when_refined()
    {
        var kind = EventKinds.Classify("birthday", "primary", "Dave");
        Assert.Equal(EventKinds.Birthday, EventKinds.Refine(kind, "birthday"));
    }

    [Theory]
    [InlineData("Dentist")]
    [InlineData("Standup")]
    [InlineData("")]
    [InlineData(null)]
    public void Everything_else_is_default(string? title) =>
        Assert.Equal(EventKinds.Default, EventKinds.Classify(null, "work@example.com", title));

    [Fact]
    public void An_unknown_google_type_falls_through_rather_than_throwing()
    {
        // Google adds event types over time; one we have not seen must not break the day.
        Assert.Equal(EventKinds.Default, EventKinds.Classify("somethingNew", "work@example.com", "Meeting"));
    }

    [Fact]
    public void The_dto_carries_the_kind_and_the_raw_signal()
    {
        var inferred = CalendarEventDto.From(new CalendarEvent
        {
            Id = 1, Source = "google", Title = "Bryson Jones Birthday",
            GoogleCalendarId = "work@example.com", CalendarName = "Work",
        });

        // Kind is set, but eventType is null — so the panel can tell this was read off the title.
        Assert.Equal(EventKinds.Birthday, inferred.Kind);
        Assert.Null(inferred.GoogleEventType);

        var stated = CalendarEventDto.From(new CalendarEvent
        {
            Id = 2, Source = "google", Title = "Dave",
            GoogleCalendarId = "primary", GoogleEventType = "birthday",
        });

        Assert.Equal(EventKinds.Birthday, stated.Kind);
        Assert.Equal("birthday", stated.GoogleEventType);
    }

    [Fact]
    public void A_local_event_is_still_classified()
    {
        // The local store has no Google fields at all; the title is the only signal it can offer.
        var dto = CalendarEventDto.From(new CalendarEvent { Id = 3, Source = "local", Title = "Ivy's birthday" });
        Assert.Equal(EventKinds.Birthday, dto.Kind);
    }
}
