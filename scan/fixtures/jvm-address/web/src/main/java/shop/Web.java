package shop;

public class Web {
    // Адрес объекта литералом: связь web → worker (как VisitsServiceClient у Petclinic).
    private String worker = "http://worker/api";
    private String balanced = "lb://helper";
    private String again = "http://worker/other";
    private String joined = "http://helper/" + "path";
    private String dotted = "https://example.com/x";
    private String local = "http://localhost/x";
    private String port = "http://worker:8080/x";
    private String unknown = "http://unknown/";
    private String self = "http://web/";
    private String text = "see http://worker/";
    // "http://helper/" в комментарии
    /* "http://db/" */
}
