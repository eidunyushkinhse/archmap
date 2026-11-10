public class ConfigTests
{
    public void Reads() => config.GetValue<int>("TestValue");
}
