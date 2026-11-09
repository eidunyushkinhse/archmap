public class RoutesTests
{
    public void Run(WebApplication app) => app.MapGet("/from-test", () => "x");
}
