namespace Shop.Api.Options;

public class CatalogOptions
{
    public string? PicBaseUrl { get; set; }
    public bool UseCustomizationData { get; set; }
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);
}

public class PaymentOptions
{
    public bool PaymentSucceeded { get; set; } = true;
}

public class AuthOptions
{
    public string Authority { get; set; } = "https://identity";
    public List<string> Scopes { get; set; } = new();
}
