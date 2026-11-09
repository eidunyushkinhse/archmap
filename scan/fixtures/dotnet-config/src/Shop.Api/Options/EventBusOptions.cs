namespace Shop.Api.Options;

public class EventBusOptions
{
    public string SubscriptionClientName { get; set; }
    public int RetryCount { get; set; } = 10;
    public required string Exchange { get; init; }
    public static string Ignored { get; set; }
    public string ReadOnly { get; }

    public class Nested
    {
        public int Inner { get; set; }
    }
}
